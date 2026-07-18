import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAlert,
  normalizeJobs,
  runMonitor,
  slugify,
} from "../scripts/check-jobs.mjs";

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
