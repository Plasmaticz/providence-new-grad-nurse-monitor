import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CAMPAIGN = "rn-resident-graduate";
export const CAMPAIGN_URL =
  "https://providence.jobs/campaigns/rn-resident-graduate/jobs/";
export const SEARCH_API =
  "https://prod-search-api.jobsyn.org/api/v1/solr/search";

const TITLE_PATTERN =
  /\b(?:graduate nurse|new grad(?:uate)?(?: rn| nurse)?|rn resident|nurse resident|rn residency|nurse residency)\b/i;

export function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[A-Za-z0-9_]+/g)
    ?.join("-")
    .toLowerCase() ?? "";
}

export function toJob(raw) {
  const id = String(raw.guid ?? raw.id ?? raw.reqid ?? "").trim();
  const title = String(raw.title_exact ?? raw.title ?? "").trim();
  const location = String(raw.location_exact ?? raw.location ?? "").trim();
  const titleSlug = raw.title_slug || slugify(title);
  const locationSlug = slugify(location);

  if (!id || !title || !locationSlug || !titleSlug) return null;

  return {
    id,
    title,
    location,
    requisitionId: String(raw.reqid ?? "").trim(),
    postedAt: raw.date_new ?? raw.date_added ?? "",
    url: `https://providence.jobs/${locationSlug}/${titleSlug}/${id}/job/`,
  };
}

export function normalizeJobs(payloads) {
  const jobs = new Map();

  for (const payload of payloads) {
    const rawJobs = [...(payload.featured_jobs ?? []), ...(payload.jobs ?? [])];
    for (const raw of rawJobs) {
      const job = toJob(raw);
      if (job && TITLE_PATTERN.test(job.title)) jobs.set(job.id, job);
    }
  }

  return [...jobs.values()].sort((a, b) =>
    `${b.postedAt}${b.id}`.localeCompare(`${a.postedAt}${a.id}`),
  );
}

async function fetchPage(page, fetchImpl) {
  const query = new URLSearchParams({
    page: String(page),
    campaigns: CAMPAIGN,
    num_items: "100",
  });
  const response = await fetchImpl(`${SEARCH_API}?${query}`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "providence-new-grad-monitor/1.0",
      "X-Origin": "providence.jobs",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Providence search returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload.jobs) || !payload.pagination) {
    throw new Error("Providence search returned an unexpected response");
  }
  return payload;
}

export async function fetchJobs(fetchImpl = fetch) {
  const first = await fetchPage(1, fetchImpl);
  const totalPages = Math.max(1, Number(first.pagination.total_pages) || 1);
  const payloads = [first];

  for (let page = 2; page <= Math.min(totalPages, 20); page += 1) {
    payloads.push(await fetchPage(page, fetchImpl));
  }

  return normalizeJobs(payloads);
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    return {
      initialized: parsed.initialized === true,
      seen: Array.isArray(parsed.seen) ? parsed.seen.map(String) : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { initialized: false, seen: [] };
    throw new Error(`Could not read ${statePath}: ${error.message}`);
  }
}

function formatDate(value) {
  if (!value) return "Not listed";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
}

export function buildAlert(jobs) {
  const noun = jobs.length === 1 ? "job" : "jobs";
  const sections = jobs.map((job) => {
    const requisition = job.requisitionId
      ? `\n- Requisition: ${job.requisitionId}`
      : "";
    return `## [${job.title}](${job.url})\n\n- Location: ${job.location}\n- Posted: ${formatDate(job.postedAt)}${requisition}`;
  });

  return [
    `# ${jobs.length} new Providence new-grad nursing ${noun}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    `Source: [Providence RN Resident & Graduate jobs](${CAMPAIGN_URL})`,
    "",
    `_Checked ${new Date().toISOString()}_`,
  ].join("\n");
}

async function setActionsOutputs(values, outputPath) {
  if (!outputPath) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(outputPath, `${lines}\n`, "utf8");
}

export async function runMonitor({
  statePath,
  alertPath,
  actionsOutputPath,
  alertCurrent = false,
  fetchImpl = fetch,
}) {
  const previous = await readState(statePath);
  const jobs = await fetchJobs(fetchImpl);
  const seen = new Set(previous.seen);
  const unseen = jobs.filter((job) => !seen.has(job.id));
  const newJobs = previous.initialized || alertCurrent ? unseen : [];

  for (const job of jobs) seen.add(job.id);
  const nextState = {
    initialized: true,
    seen: [...seen].sort(),
  };
  const stateChanged =
    !previous.initialized ||
    JSON.stringify(nextState.seen) !== JSON.stringify([...previous.seen].sort());

  if (stateChanged) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }

  if (newJobs.length > 0) {
    await mkdir(dirname(alertPath), { recursive: true });
    await writeFile(alertPath, buildAlert(newJobs), "utf8");
  }

  await setActionsOutputs(
    {
      new_count: newJobs.length,
      current_count: jobs.length,
      state_changed: stateChanged,
      baseline_created: !previous.initialized && !alertCurrent,
    },
    actionsOutputPath,
  );

  return { jobs, newJobs, stateChanged, baselineCreated: !previous.initialized };
}

function parseArgs(args) {
  const options = {
    statePath: "data/seen_jobs.json",
    alertPath: "new_jobs.md",
    actionsOutputPath: process.env.GITHUB_OUTPUT,
    alertCurrent: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--alert-current") options.alertCurrent = true;
    else if (arg === "--state") options.statePath = args[++index];
    else if (arg === "--alert-file") options.alertPath = args[++index];
    else if (arg === "--output") options.actionsOutputPath = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.statePath = resolve(options.statePath);
  options.alertPath = resolve(options.alertPath);
  return options;
}

async function main() {
  const result = await runMonitor(parseArgs(process.argv.slice(2)));
  if (result.baselineCreated && result.newJobs.length === 0) {
    console.log(`Baseline saved with ${result.jobs.length} current jobs; no alert sent.`);
  } else {
    console.log(
      `Found ${result.jobs.length} current jobs and ${result.newJobs.length} new jobs.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
