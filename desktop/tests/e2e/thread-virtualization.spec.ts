import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const CHANNEL = "general";
const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const REPLY_COUNT = 2_419;
const TARGET_REPLY_INDEX = 23;

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ channelName }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName }) ?? false,
        { channelName: CHANNEL },
      );
    })
    .toBe(true);
}

test("a 2,419-reply thread keeps only the visible rows mounted and remains writable", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await waitForMockLiveSubscription(page);

  const seededThread = await page.evaluate(
    ({ channelName, replyCount, targetReplyIndex }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            parentEventId?: string;
            createdAt?: number;
          }) => { id: string };
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) {
        return null;
      }

      const base = Math.floor(Date.now() / 1_000) - replyCount - 60;
      const root = emit({
        channelName,
        content: "Long-running project thread",
        createdAt: base,
      });
      let targetId: string | null = null;
      for (let index = 0; index < replyCount; index += 1) {
        const reply = emit({
          channelName,
          content: `Reply ${index + 1} of ${replyCount}`,
          parentEventId: root.id,
          createdAt: base + index + 1,
        });
        if (index === targetReplyIndex) {
          targetId = reply.id;
        }
      }
      return { rootId: root.id, targetId };
    },
    {
      channelName: CHANNEL,
      replyCount: REPLY_COUNT,
      targetReplyIndex: TARGET_REPLY_INDEX,
    },
  );
  expect(seededThread?.rootId).toBeTruthy();
  expect(seededThread?.targetId).toBeTruthy();

  await page.evaluate(
    ({ channelId, targetId }) => {
      window.location.hash = `/channels/${channelId}?messageId=${targetId}`;
    },
    { channelId: CHANNEL_ID, targetId: seededThread?.targetId },
  );

  const threadPanel = page.getByTestId("message-thread-panel");
  const replies = threadPanel.getByTestId("message-thread-replies");
  await expect(threadPanel).toBeVisible();
  await expect(replies).toHaveAttribute("data-virtualized", "true", {
    timeout: 30_000,
  });
  await expect(
    replies.getByText(`Reply ${TARGET_REPLY_INDEX + 1} of ${REPLY_COUNT}`, {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });

  const mountedReplyRows = replies.getByTestId("message-row");
  await expect.poll(() => mountedReplyRows.count()).toBeGreaterThan(0);
  expect(await mountedReplyRows.count()).toBeLessThan(80);

  await threadPanel.getByTestId("thread-scroll-to-latest").click();
  await expect(
    replies.getByText(`Reply ${REPLY_COUNT} of ${REPLY_COUNT}`, {
      exact: true,
    }),
  ).toBeVisible();

  const editor = threadPanel
    .getByTestId("message-composer")
    .locator("[contenteditable='true']");
  await editor.fill("Typing stays responsive in the long thread");
  await expect(editor).toHaveText("Typing stays responsive in the long thread");

  await threadPanel.getByRole("button", { name: "Close panel" }).click();
  await expect(threadPanel).toHaveCount(0);
});
