import { test, expect } from "@playwright/test";

// Self-contained page so the example needs no server.
const page = `<h1>Todos</h1><input aria-label="New todo"><button>Add</button><ul></ul>
<script>document.querySelector("button").onclick = () => { const i = document.querySelector("input");
if (!i.value.trim()) return; const li = document.createElement("li"); li.textContent = i.value; document.querySelector("ul").append(li); i.value = ""; };</script>`;

test.beforeEach(async ({ page: p }) => {
  await p.setContent(page);
});

test.describe("Todo list", () => {
  test("adds a todo", async ({ page: p }) => {
    await p.getByLabel("New todo").fill("Write tests");
    await p.getByRole("button", { name: "Add" }).click();
    await expect(p.getByRole("listitem")).toHaveText(["Write tests"]);
  });

  test("ignores an empty todo", async ({ page: p }) => {
    await p.getByRole("button", { name: "Add" }).click();
    await expect(p.getByRole("listitem")).toHaveCount(0);
  });

  // Set DEMO_FAIL=1 to see how a failure shows up in the PR comment.
  test("shows the heading", async ({ page: p }) => {
    await expect(p.getByRole("heading")).toHaveText(process.env.DEMO_FAIL ? "Todo list" : "Todos");
  });

  test.skip("syncs with the server", async () => {});
});
