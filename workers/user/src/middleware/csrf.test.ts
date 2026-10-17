import { createBffCsrfTestSuite } from "@0g0-id/shared/test-helpers";

createBffCsrfTestSuite({
  origin: "https://user.0g0.xyz",
  label: "ユーザー画面",
  otherBffOrigin: "https://admin.0g0.xyz",
  otherBffLabel: "admin",
  refererPath: "profile.html",
});
