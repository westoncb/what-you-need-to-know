import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_PROFILE = "I am interested in software engineering and AI research.";
const LOCAL_PROFILE_PATH = fileURLToPath(new URL("../../../profile.local.txt", import.meta.url));

/** Copy profile.example.txt to profile.local.txt to personalize locally. Never commit the local file. */
export function loadProfile(profilePath = LOCAL_PROFILE_PATH): string {
  if (!existsSync(profilePath)) return DEFAULT_PROFILE;
  const profile = readFileSync(profilePath, "utf8").trim();
  if (!profile) throw new Error("The local profile file is empty; add your interests or remove it to use the default.");
  return profile;
}
