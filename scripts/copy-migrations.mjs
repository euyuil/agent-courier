import { cpSync, existsSync, mkdirSync } from 'node:fs';
const source = 'src/storage/migrations';
if (existsSync(source)) {
  mkdirSync(process.argv[2], { recursive: true });
  cpSync(source, process.argv[2], { recursive: true });
}
