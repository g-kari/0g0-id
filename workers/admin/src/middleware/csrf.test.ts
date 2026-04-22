import { createBffCsrfTestSuite } from "@0g0-id/shared/test-helpers";

createBffCsrfTestSuite({
  origin: "https://admin.0g0.xyz",
  label: "管理画面",
  otherBffOrigin: "https://user.0g0.xyz",
  otherBffLabel: "user",
  refererPath: "dashboard.html",
});
