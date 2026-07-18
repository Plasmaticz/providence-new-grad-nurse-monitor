import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAlert,
  buildListingsSection,
  normalizeJobs,
  runMonitor,
  slugify,
} from "../scripts/check-jobs.mjs";
import {
  sendDiscordAlert,
  splitDiscordMessage,
} from "../scripts/send-discord.mjs";

const rawJobs = [
  {
    guid: "JOB-1",
    reqid: "12345",
    title_exact: "RN Resident - Acute Care",
    title_slug: "rn-resident-acute-care",
    location_exact: "Richland, WA",
    date_new: "2026-07-17T10:00:00Z",
  },
  {
    guid: "JOB-2",
    reqid: "67890",
    title_exact: "Graduate Nurse - Obstetrics",
    title_slug: "graduate-nurse-obstetrics",
    location_exact: "Lubbock, TX",
    date_new: "2026-07-18T10:00:00Z",
  },
];

function responseFor(jobs) {
  return {
    ok: true,
    json: async () => ({
      featured_jobs: [],
      jobs,
      pagination: { total_pages: 1, total: jobs.length },
    }),
  };
}

test("slugify matches Providence job URL slugs", () => {
  assert.equal(slugify("Portland, OR"), "portland-or");
  assert.equal(slugify("Coeur d'Alene, ID"), "coeur-d-alene-id");
});

test("normalizeJobs keeps new-grad titles and removes duplicates", () => {
  const jobs = normalizeJobs([
    {
      featured_jobs: [rawJobs[0]],
      jobs: [...rawJobs, { ...rawJobs[0] }, { ...rawJobs[0], guid: "OTHER", title_exact: "RN II" }],
    },
  ]);

  assert.deepEqual(jobs.map((job) => job.id), ["JOB-2", "JOB-1"]);
  assert.match(jobs[0].url, /graduate-nurse-obstetrics\/JOB-2\/job\/$/);
});

test("first run creates a quiet baseline and later runs alert once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "providence-monitor-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");

  try {
    await writeFile(statePath, '{"initialized":false,"seen":[]}\n');
    const baseline = await runMonitor({
      statePath,
      alertPath,
      fetchImpl: async () => responseFor([rawJobs[0]]),
    });
    assert.equal(baseline.newJobs.length, 0);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).seen.length, 1);

    const update = await runMonitor({
      statePath,
      alertPath,
      fetchImpl: async () => responseFor(rawJobs),
    });
    assert.deepEqual(update.newJobs.map((job) => job.id), ["JOB-2"]);
    assert.match(await readFile(alertPath, "utf8"), /Graduate Nurse - Obstetrics/);

    const repeat = await runMonitor({
      statePath,
      alertPath,
      fetchImpl: async () => responseFor(rawJobs),
    });
    assert.equal(repeat.newJobs.length, 0);
    assert.equal(repeat.stateChanged, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("alert includes direct links and requisition IDs", () => {
  const jobs = normalizeJobs([{ featured_jobs: [], jobs: [rawJobs[0]] }]);
  const alert = buildAlert(jobs);
  assert.match(alert, /https:\/\/providence\.jobs\/richland-wa\//);
  assert.match(alert, /Requisition: 12345/);
});

test("manual alert sends current jobs even after initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "providence-manual-alert-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");

  try {
    await writeFile(statePath, '{"initialized":true,"seen":["JOB-1","JOB-2"]}\n');
    const result = await runMonitor({
      statePath,
      alertPath,
      alertCurrent: true,
      fetchImpl: async () => responseFor(rawJobs),
    });

    assert.equal(result.newJobs.length, 2);
    assert.match(await readFile(alertPath, "utf8"), /2 new Providence/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("README listings show current jobs and remain stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "providence-readme-"));
  const statePath = join(directory, "seen.json");
  const alertPath = join(directory, "alert.md");
  const readmePath = join(directory, "README.md");

  try {
    await writeFile(statePath, '{"initialized":true,"seen":["JOB-1","JOB-2"]}\n');
    await writeFile(
      readmePath,
      "# Monitor\n\n<!-- PROVIDENCE-JOBS:START -->\nWaiting\n<!-- PROVIDENCE-JOBS:END -->\n",
    );
    const options = {
      statePath,
      alertPath,
      readmePath,
      fetchImpl: async () => responseFor(rawJobs),
    };

    const update = await runMonitor(options);
    const readme = await readFile(readmePath, "utf8");
    assert.equal(update.readmeChanged, true);
    assert.match(readme, /2 current openings/);
    assert.match(readme, /Graduate Nurse - Obstetrics/);
    assert.match(readme, /\| Lubbock, TX \| 2026-07-18 \| 67890 \|/);

    const repeat = await runMonitor(options);
    assert.equal(repeat.readmeChanged, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty listings section renders a useful repository message", () => {
  assert.match(buildListingsSection([]), /No matching openings/);
});

test("Discord alerts stay within the message limit", () => {
  const chunks = splitDiscordMessage(`New jobs\n${"x".repeat(4000)}`);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
});

test("Discord sender disables mentions and requests confirmation", async () => {
  const requests = [];
  await sendDiscordAlert(
    "https://discord.com/api/webhooks/example/token",
    "A new RN Resident job is open",
    async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    },
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /wait=true/);
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content, /RN Resident/);
});
