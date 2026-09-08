import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultRunConfig } from "./harness";
import { providerCreditPricing } from "../../../src/lib/credits/provider-pricing";
import {
  geminiModelRoleNames,
  geminiModelRoles,
  resolveGeminiModel,
} from "../../../src/lib/inference/gemini-models";

describe("chat eval model selection", () => {
  test("the eval sends the same role names as the editor and headless runner", () => {
    const config = defaultRunConfig("http://localhost:3000");
    expect(config.simpleModel).toBe(geminiModelRoleNames.chatSimple);
    expect(config.complexModel).toBe(geminiModelRoleNames.chat);
    expect(config.gateModel).toBe(geminiModelRoleNames.fastDecision);
    expect(config.judgeModel).toBe(geminiModelRoles.fastDecision);
  });

  test("every eval role resolves to a priced hosted model", () => {
    const config = defaultRunConfig("http://localhost:3000");
    for (const model of [config.simpleModel, config.complexModel, config.gateModel, config.judgeModel!]) {
      expect(providerCreditPricing("gemini", resolveGeminiModel(model))).toBeTruthy();
    }
  });

  test("the committed eval baseline covers the production model configuration", () => {
    const report = JSON.parse(readFileSync(
      new URL("../../../../evals/cut-chat.latest-report.json", import.meta.url),
      "utf8",
    )) as { configs: { chatModel: string; gateModel: string }[] };
    const config = defaultRunConfig("http://localhost:3000");
    const simple = resolveGeminiModel(config.simpleModel);
    const complex = resolveGeminiModel(config.complexModel);
    const chatModel = simple === complex ? simple : `${simple} | complex→${complex}`;
    expect(report.configs.some((baseline) =>
      baseline.chatModel === chatModel && baseline.gateModel === resolveGeminiModel(config.gateModel),
    )).toBe(true);
  });
});
