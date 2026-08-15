// Export jobs for browser-resident projects. The render happens in this tab
// (exportClient's in-tab pipeline), so the registry is tab-local memory: rows
// exist for the dock's feed poll, and a reload drops them while the finished
// files stay listed on the project's exports shelf. Shapes match the engine's
// job feed so the dock renders every residency the same way.

export interface BrowserExportJob {
  id: string;
  projectId: string;
  projectName?: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  outName?: string;
  error?: string;
  startedAt?: number;
  createdAt?: number;
}

const jobs: BrowserExportJob[] = [];

/** Claim a feed row for a render this tab is about to run. */
export function reserveBrowserExportJob(projectId: string, projectName?: string): BrowserExportJob {
  const now = Date.now();
  const job: BrowserExportJob = {
    id: crypto.randomUUID().slice(0, 8),
    projectId,
    projectName,
    status: "running",
    progress: 0,
    startedAt: now,
    createdAt: now,
  };
  jobs.push(job);
  return job;
}

export function updateBrowserExportJob(
  id: string,
  patch: Partial<Omit<BrowserExportJob, "id" | "projectId">>
): void {
  const job = jobs.find((j) => j.id === id);
  if (job) Object.assign(job, patch);
}

export function getBrowserExportJob(id: string): BrowserExportJob | undefined {
  return jobs.find((j) => j.id === id);
}

export function listBrowserExportJobs(): BrowserExportJob[] {
  return jobs;
}

export function removeBrowserExportJob(id: string): void {
  const at = jobs.findIndex((j) => j.id === id);
  if (at !== -1) jobs.splice(at, 1);
}
