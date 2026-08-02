import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export async function prepareTarget(dir: string): Promise<string> {
  const absolute = path.resolve(dir);

  let entries: string[];
  try {
    entries = await readdir(absolute);
  } catch (thrown) {
    const error = thrown as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      await mkdir(absolute, { recursive: true });
      return absolute;
    }
    if (error.code === "ENOTDIR") {
      throw new Error(`${absolute} exists and is not a directory.`);
    }
    throw error;
  }

  if (entries.length > 0) {
    throw new Error(`${absolute} is not empty. Choose another directory or empty this one first.`);
  }
  return absolute;
}
