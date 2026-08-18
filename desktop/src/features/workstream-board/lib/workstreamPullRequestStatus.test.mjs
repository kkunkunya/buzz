import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkstreamPollingRegistry,
  fetchBuzzPullRequestStatus,
  fetchGithubPullRequestStatus,
  parseWorkstreamPullRequestReference,
  parseWorkstreamPullRequestReferences,
} from "./workstreamPullRequestStatus.ts";

const OWNER = "a".repeat(64);
const EVENT = "b".repeat(64);
const buzz = `buzz://pr?id=${EVENT}&owner=${OWNER}&d=buzz`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("parses canonical Buzz, GitHub, malformed, and unsupported references", () => {
  const refs = parseWorkstreamPullRequestReferences([
    buzz,
    { url: "https://github.com/Block/Buzz/pull/42", label: "labeled PR" },
    "https://github.com/Block/Buzz/pull/42",
    "https://github.com/block/buzz/issues/42",
    "https://example.com/pr/1",
    "not a url",
    null,
  ]);
  assert.equal(refs[0].kind, "buzz");
  assert.equal(refs[0].identity, `buzz:${OWNER}:buzz:${EVENT}`);
  assert.equal(refs[1].kind, "github");
  assert.equal(refs[1].href, "https://github.com/block/buzz/pull/42");
  assert.equal(refs[2].kind, "github");
  assert.equal(refs[3].kind, "unsupported");
  assert.equal(refs[3].reason, "malformed");
  assert.equal(refs[4].reason, "unsupported-provider");
  assert.equal(refs[5].reason, "malformed");
  assert.equal(refs[6].reason, "invalid-field");
});

test("GitHub status reports lifecycle and latest review state", async () => {
  const ref = parseWorkstreamPullRequestReference(
    "https://github.com/block/buzz/pull/42",
  );
  assert.equal(ref.kind, "github");
  const result = await fetchGithubPullRequestStatus(ref, {
    fetcher: async (url) =>
      String(url).endsWith("/reviews?per_page=100")
        ? response([
            {
              user: { login: "reviewer" },
              state: "APPROVED",
              submitted_at: "2026-08-18T00:00:00Z",
            },
          ])
        : response({
            number: 42,
            title: "Board PR",
            state: "closed",
            draft: false,
            merged_at: "2026-08-18T01:00:00Z",
            requested_reviewers: [],
          }),
  });
  assert.deepEqual(result, {
    status: "live",
    provider: "github",
    href: "https://github.com/block/buzz/pull/42",
    repository: "block/buzz",
    number: 42,
    title: "Board PR",
    lifecycle: "merged",
    reviewState: "approved",
  });
});

test("Buzz status consumes root and existing NIP-34 status events", async () => {
  const ref = parseWorkstreamPullRequestReference(buzz);
  assert.equal(ref.kind, "buzz");
  const root = {
    id: EVENT,
    pubkey: OWNER,
    kind: 1618,
    created_at: 10,
    content: "Wire board",
    tags: [
      ["a", `30617:${OWNER}:buzz`],
      ["d", "pr-1"],
      ["subject", "Wire board"],
      ["p", "c".repeat(64)],
    ],
  };
  const status = {
    id: "c".repeat(64),
    pubkey: OWNER,
    kind: 1631,
    created_at: 20,
    content: "",
    tags: [
      ["e", EVENT],
      ["a", `30617:${OWNER}:buzz`],
    ],
  };
  const result = await fetchBuzzPullRequestStatus(ref, async (filter) =>
    filter.kinds[0] === 1618 ? [root] : [status],
  );
  assert.equal(result.status, "live");
  assert.equal(result.lifecycle, "merged");
  assert.equal(result.title, "Wire board");
  assert.equal(result.reviewState, "review-requested");
});

test("polling deduplicates canonical identities and tears down", async () => {
  let requests = 0;
  let aborted = false;
  let resolveRequest;
  const pending = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const reference = parseWorkstreamPullRequestReference(
    "https://github.com/block/buzz/pull/42",
  );
  assert.equal(reference.kind, "github");
  const registry = createWorkstreamPollingRegistry({
    fetcher: async (_url, init) => {
      requests += 1;
      init.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await pending;
      return response({
        number: 42,
        title: "Board",
        state: "open",
        draft: false,
      });
    },
    intervalMs: 1000,
  });
  const listener = () => {};
  const unsubscribeOne = registry.subscribe(reference, listener);
  const unsubscribeTwo = registry.subscribe(reference, () => {});
  assert.equal(registry.entryCount(), 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests, 2);
  unsubscribeOne();
  assert.equal(registry.entryCount(), 1);
  unsubscribeTwo();
  assert.equal(registry.entryCount(), 0);
  assert.equal(aborted, true);
  resolveRequest();
});
