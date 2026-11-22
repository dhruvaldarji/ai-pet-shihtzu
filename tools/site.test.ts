import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { escapeHtml, nativeInstallCandidate } from "./site";

const template = join(import.meta.dir, "../site/index.html");

test("dynamic HTML values are escaped", () => {
  expect(escapeHtml(`<Louis & "friends" 'today'>`)).toBe(
    "&lt;Louis &amp; &quot;friends&quot; &#39;today&#39;&gt;",
  );
});

test("native install metadata is versioned but the source template has no active install link", async () => {
  const candidate = new URL(nativeInstallCandidate("v1.2.3"));
  expect(candidate.protocol).toBe("codex:");
  expect(candidate.hostname).toBe("pets");
  expect(candidate.pathname).toBe("/install");
  expect(candidate.searchParams.get("name")).toBe("Louis");
  expect(candidate.searchParams.get("imageUrl")).toBe(
    "https://louis.dhruvaldarji.com/releases/v1.2.3/spritesheet.webp",
  );
  expect(candidate.searchParams.get("spriteVersionNumber")).toBe("2");
  expect(() => nativeInstallCandidate("v1.2.3\n")).toThrow();

  const html = await readFile(template, "utf8");
  const links: string[] = [];
  let disabledButtons = 0;
  let openDetails = 0;
  let invalidImages = 0;
  let mains = 0;
  let mainTabIndex: string | null = null;
  let summaryText = "";
  const rewriter = new HTMLRewriter()
    .on("main#main", {
      element(element) {
        mains++;
        mainTabIndex = element.getAttribute("tabindex");
      },
    })
    .on("a[href]", {
      element(element) {
        links.push(element.getAttribute("href") ?? "");
      },
    })
    .on("button[disabled]", {
      element() {
        disabledButtons++;
      },
    })
    .on("details[open]", {
      element() {
        openDetails++;
      },
    })
    .on("summary", {
      text(text) {
        summaryText += text.text;
      },
    })
    .on("img", {
      element(element) {
        if (
          !element.getAttribute("alt") ||
          element.getAttribute("width") !== "192" ||
          element.getAttribute("height") !== "208"
        )
          invalidImages++;
      },
    });
  rewriter.transform(html);
  expect(mains).toBe(1);
  expect(mainTabIndex ?? "").toBe("-1");
  expect(disabledButtons).toBe(1);
  expect(openDetails).toBe(0);
  expect(summaryText).toContain("close this panel to hide it");
  expect(invalidImages).toBe(0);
  expect(links.some((href) => href.startsWith("codex:"))).toBe(false);
});

test("nested 404 routes resolve the stylesheet and home links at the site root", async () => {
  const html = await readFile(join(import.meta.dir, "../site/404.html"), "utf8");
  const anchors: string[] = [];
  const stylesheets: string[] = [];
  let mainTabIndex: string | null = null;
  const transformed = new HTMLRewriter()
    .on("main#main", {
      element(element) {
        mainTabIndex = element.getAttribute("tabindex");
      },
    })
    .on("link[rel=stylesheet]", {
      element(element) {
        stylesheets.push(element.getAttribute("href") ?? "");
      },
    })
    .on("a[href]", {
      element(element) {
        anchors.push(element.getAttribute("href") ?? "");
      },
    })
    .transform(html);
  expect(typeof transformed).toBe("string");
  expect(mainTabIndex ?? "").toBe("-1");
  expect(anchors).toContain("#main");
  expect(stylesheets).toEqual(["/styles.css"]);

  const nestedMissingUrl = new URL("https://louis.dhruvaldarji.com/releases/v1.2.4/missing");
  const homeLinks = anchors.filter((href) => href === "/");
  expect(homeLinks.length).toBe(2);
  for (const href of homeLinks) expect(new URL(href, nestedMissingUrl).pathname).toBe("/");
  for (const href of stylesheets)
    expect(new URL(href, nestedMissingUrl).pathname).toBe("/styles.css");
});

test("reduced-motion styles replace the optional animation with a still frame", async () => {
  const css = await readFile(join(import.meta.dir, "../site/styles.css"), "utf8");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain(".animation[open] .animated-preview");
  expect(css).toContain(".animation[open] .still-preview");
});
