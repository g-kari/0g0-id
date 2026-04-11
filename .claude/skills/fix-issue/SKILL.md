---
name: fix-issue
description: GitHub Issueの修正ワークフロー
disable-model-invocation: true
---

# GitHub Issue修正スキル

## 使用方法

`/fix-issue 123` — Issue #123 を修正

## ワークフロー

1. `gh issue view 123` でIssue内容確認
2. 修正ブランチ作成: `git checkout -b fix/issue-123`
3. コード修正実施
4. `npm run typecheck` で型チェック
5. コミット: `git commit -m "バグ修正: Issue #123 〇〇"`
6. PR作成: `gh pr create --title "バグ修正: 〇〇" --body "Closes #123"`
