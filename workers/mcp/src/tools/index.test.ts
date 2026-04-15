import { describe, it, expect } from "vite-plus/test";
import * as tools from "./index";

const expectedUserTools = [
  "listUsersTool",
  "getUserTool",
  "banUserTool",
  "unbanUserTool",
  "deleteUserTool",
  "getUserLoginHistoryTool",
  "getUserLoginStatsTool",
  "getUserLoginTrendsTool",
  "getUserProvidersTool",
  "listUserSessionsTool",
  "revokeUserSessionsTool",
  "getUserOwnedServicesTool",
  "getUserAuthorizedServicesTool",
  "updateUserRoleTool",
];

const expectedServiceTools = [
  "listServicesTool",
  "getServiceTool",
  "createServiceTool",
  "updateServiceTool",
  "deleteServiceTool",
  "rotateServiceSecretTool",
  "listRedirectUrisTool",
  "addRedirectUriTool",
  "deleteRedirectUriTool",
  "listServiceUsersTool",
  "revokeServiceUserAccessTool",
  "transferServiceOwnershipTool",
];

const expectedAuditTools = ["getAuditLogsTool", "getAuditStatsTool"];

const expectedMetricsTools = [
  "getSystemMetricsTool",
  "getSuspiciousLoginsTool",
  "getServiceTokenStatsTool",
  "getActiveUserStatsTool",
  "getDailyActiveUsersTool",
  "getLoginTrendsTool",
  "getUserRegistrationsTool",
];

const allExpectedTools = [
  ...expectedUserTools,
  ...expectedServiceTools,
  ...expectedAuditTools,
  ...expectedMetricsTools,
];

describe("tools/index エクスポート", () => {
  it.each(allExpectedTools)("%s がエクスポートされている", (toolName) => {
    expect(tools).toHaveProperty(toolName);
  });

  it("全ツールがdefinitionとhandlerを持つ", () => {
    for (const name of allExpectedTools) {
      const tool = (tools as Record<string, unknown>)[name] as {
        definition?: unknown;
        handler?: unknown;
      };
      expect(tool.definition).toBeDefined();
      expect(tool.handler).toBeDefined();
    }
  });

  it("想定外のエクスポートが含まれていない", () => {
    const exportedKeys = Object.keys(tools);
    expect(exportedKeys.sort()).toEqual([...allExpectedTools].sort());
  });
});
