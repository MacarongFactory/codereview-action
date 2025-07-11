import * as github from "@actions/github";
import i18n from "i18next";

import { getSlackMessage, updateMessage, postMessage, addCommentToPR } from "../slack";
import { Reviewers } from "../types";
import { debug } from "../utils";
import { findSlackTsInComments } from "./common/find-slack-ts-in-comments";
import { getReviewerSlackId } from "./common/get-reviewer-slack-id";
import { SKIP_COMMENT_MARKER } from "../constants";
import * as core from "@actions/core";

const slackChannel: string = core.getInput("slack_channel");
const slackWorkspace: string = core.getInput("slack_workspace");

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
  let slackTs = await findSlackTsInComments(octokit, prNumber, owner, repo);

  // 슬랙 메시지가 없으면 새로 생성
  if (!slackTs) {
    // 슬랙 메시지 생성
    const prTitle = pull_request.title;
    const prAuthor = pull_request.user?.login;
    const fallbackText = `PR 코드리뷰 요청: ${prTitle} (작성자: ${prAuthor}, 리뷰어: ${newReviewersStr})`;
    // Block 생성 (기존 buildSlackBlock 로직을 간단히 인라인)
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*📮 리뷰어: ${newReviewersStr} <${pull_request.html_url}|${prTitle}> by ${prAuthor} *`,
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${repo}:*\n<${pull_request.html_url}|${prTitle}>`,
        },
      },
    ];
    slackTs = await postMessage(blocks, fallbackText);
    // PR에 슬랙 메시지 ts 코멘트 남기기
    const prOpenComment = i18n.t("pr_open_comment");
    const slackMessageComment = `${prOpenComment}(https://${slackWorkspace}.slack.com/archives/${slackChannel}/p${slackTs?.replace(".", "")})\n<!-- (ts${slackTs}) ${SKIP_COMMENT_MARKER} -->`;
    await addCommentToPR(
      octokit.rest,
      prNumber,
      owner,
      repo,
      slackMessageComment
    );
    return;
  }

  // 슬랙 메시지가 있으면 기존대로 업데이트
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
