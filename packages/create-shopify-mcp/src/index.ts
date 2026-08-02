import { run } from "./run";

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((thrown: unknown) => {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    process.exitCode = 1;
  });
