import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PendingJob } from "./types.js";

const dataDir = path.resolve("data");
const filePath = path.join(dataDir, "pending-jobs.json");

export async function saveJob(job: PendingJob): Promise<void> {
  const jobs = await readJobs();
  const next = jobs.filter((existing) => (
    existing.jobId !== job.jobId &&
    !(existing.chatId === job.chatId && existing.triggerUserId === job.triggerUserId && existing.status === "pending")
  ));
  next.push(job);
  await writeJobs(next);
}

export async function findPendingJob(chatId: string, userId: string): Promise<PendingJob | null> {
  const now = Date.now();
  const jobs = await readJobs();
  const candidates = jobs
    .filter((job) => (
      job.chatId === chatId &&
      job.triggerUserId === userId &&
      job.status === "pending" &&
      Date.parse(job.expiresAt) > now
    ))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return candidates[0] ?? null;
}

export async function completeJob(jobId: string): Promise<void> {
  const jobs = await readJobs();
  for (const job of jobs) {
    if (job.jobId === jobId) job.status = "completed";
  }
  await writeJobs(jobs);
}

async function readJobs(): Promise<PendingJob[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PendingJob[];
  } catch {
    return [];
  }
}

async function writeJobs(jobs: PendingJob[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(jobs, null, 2), "utf8");
}
