import { expect, test } from "bun:test";
import { checkActionPins, checkTrackedPaths } from "./security";

test("only reviewed tracked media and non-private paths pass", () => {
  expect(() =>
    checkTrackedPaths(["README.md", "assets/atlas.webp", "fixtures/runtime/preview.gif"]),
  ).not.toThrow();
  for (const path of [
    "private/photo.jpg",
    ".env",
    "local/.env.production",
    "cert.key",
    "dist/louis.zip",
    "assets/photo.png",
  ]) {
    expect(() => checkTrackedPaths([path])).toThrow();
  }
});

test("action pins are checked in parsed YAML including inline mappings and aliases", () => {
  const pin = "a".repeat(40);
  expect(() =>
    checkActionPins(Bun.YAML.parse(`jobs: {test: {steps: [{uses: actions/checkout@${pin}}]}}`)),
  ).not.toThrow();
  for (const uses of ["actions/checkout@v4", "actions/checkout@abcd", "./local-action"]) {
    expect(() =>
      checkActionPins(Bun.YAML.parse(`jobs: {test: {steps: [{uses: ${uses}}]}}`)),
    ).toThrow("full commit SHA");
  }
  expect(() =>
    checkActionPins(
      Bun.YAML.parse(
        "base: &action {uses: actions/checkout@main}\njobs: {test: {steps: [*action]}}",
      ),
    ),
  ).toThrow();
});
