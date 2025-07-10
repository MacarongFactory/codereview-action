import * as github from "@actions/github";
import i18n from "i18next";

import { getSlackMessage, updateMessage } from "../slack";
import { Reviewers } from "../types";
import { debug } from "../utils";
import { findSlackTsInComments } from "./common/find-slack-ts-in-comments";
import { getReviewerSlackId } from "./common/get-reviewer-slack-id";

export async function handleRequestReview(
  octokit: any,
  event: any,
  reviewers: Reviewers
) {
  const { pull_request } = event;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = pull_request.number;

  // 현재 리뷰어 슬랙 멘션 목록
  const newReviewersStr = getReviewerSlackId(event, reviewers);
  const newReviewers = newReviewersStr
    ? newReviewersStr.split(/, ?/).filter(Boolean)
    : [];

  // 슬랙 메시지에서 기존 멘션된 리뷰어 추출
  const slackTs = await findSlackTsInComments(octokit, prNumber, owner, repo);
  if (!slackTs) return;
  const slackMessage = await getSlackMessage(slackTs);
  const blocks = slackMessage?.blocks ?? [];

  if (!blocks?.length) return;
  const textBlock = blocks.find(
    (block: any) => block.type === "section" && block.text?.type === "mrkdwn"
  );

  if (!textBlock?.text?.text) return;

  // 기존 멘션된 리뷰어 슬랙 ID 추출 (정규식: <@...>)
  const prevMentions = (textBlock.text.text.match(/<@[^>]+>/g) || []).filter(Boolean);

  // 추가/제거된 리뷰어 계산
  const added = newReviewers.filter((r: any) => !prevMentions.includes(r));
  const removed = prevMentions.filter((r: any) => !newReviewers.includes(r));

  // 추가/제거된 리뷰어가 없으면 메시지 업데이트하지 않음
  if (added.length === 0 && removed.length === 0) return;

  // 멘션 메시지 생성
  let mentionText = "";
  if (added.length > 0) {
    mentionText += `리뷰 요청: ${added.join(", ")}`;
  }
  if (removed.length > 0) {
    if (mentionText) mentionText += "\n";
    mentionText += `리뷰 요청 해제: ${removed.join(", ")}`;
  }

  // PR 작성자 슬랙 ID
  const prAuthorSlackId = reviewers.reviewers.find(
    (rev) => rev.githubName === pull_request.user?.login
  )?.slackId;
  const requester = prAuthorSlackId
    ? `<@${prAuthorSlackId}>`
    : pull_request.user?.login ?? "assignee";

  textBlock.text.text = `*📮 ${requester} 🎁 \n${mentionText}*`;

  debug({ textBlock });
  const textBlockIndex = blocks.findIndex(
    (block: any) => block.type === "section" && block.text?.type === "mrkdwn"
  );
  blocks[textBlockIndex] = textBlock;
  await updateMessage(slackTs, blocks);
}
