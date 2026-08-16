import { rmSync } from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(process.cwd(), "dist-server");
rmSync(outputDirectory, { recursive: true, force: true });
