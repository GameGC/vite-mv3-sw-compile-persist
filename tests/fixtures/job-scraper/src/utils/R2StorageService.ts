export async function r2Exists(key: string): Promise<boolean> {
  return true;
}

export async function r2Put(key: string, data: any): Promise<void> {
  // mock R2 upload
}

export async function saveJobsToR2(jobs: any): Promise<void> {
  // mock save jobs to R2 storage
}
