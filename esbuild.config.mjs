import esbuild from "esbuild";
import process from "node:process";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "node:*"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
}
