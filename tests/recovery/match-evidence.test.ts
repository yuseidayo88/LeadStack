import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { discoveryMatchEvidence } from "@/lib/discovery/match-evidence";
import { CandidateMatchEvidence } from "@/components/discovery/match-evidence";
import type { Candidate } from "@/lib/discovery/contracts";

test("word matches cannot stand in for industry or employee evidence", () => {
  const evidence = discoveryMatchEvidence(
    {
      name: "設備工事 支援",
      business_summary: "製造業への支援を提供",
      industry_codes: [],
      employee_number: null,
    },
    {
      industry: "D",
      employeeMin: 10,
      employeeMax: 50,
      businessKeywords: ["設備", "保守", "支援"],
    },
  );
  expect(evidence).toEqual({
    industryCode: null,
    keywords: ["設備", "支援"],
    missing: ["employees", "industry"],
  });
  const markup = renderToStaticMarkup(
    createElement(CandidateMatchEvidence, {
      candidate: { match_evidence: evidence } as Candidate,
    }),
  );
  expect(markup).toContain("条件一致には含めません");
  expect(markup).toContain("名称・事業内容の語句一致");
  expect(markup).not.toContain("業種コード一致");
});

test("a stored division code is reported independently from business terms", () => {
  const evidence = discoveryMatchEvidence(
    {
      name: "試験企業",
      business_summary: "空調設備の保守",
      industry_codes: ["D", "E"],
      employee_number: 0,
    },
    {
      industry: "D",
      employeeMin: 0,
      employeeMax: 0,
      businessKeywords: ["設備"],
    },
  );
  expect(evidence).toEqual({
    industryCode: "D",
    keywords: ["設備"],
    missing: [],
  });
  const markup = renderToStaticMarkup(
    createElement(CandidateMatchEvidence, {
      candidate: { match_evidence: evidence } as Candidate,
    }),
  );
  expect(markup).toContain("業種コード一致：D（大分類）");
  expect(markup).toContain("業種を確定する根拠ではありません");
  expect(markup).not.toContain("情報不足");
});

test("explicit unknown industry and absent employee criteria are not invented missing requirements", () => {
  expect(
    discoveryMatchEvidence(
      { name: "試験", industry_codes: [], employee_number: null },
      { industry: "unknown", businessKeywords: [] },
    ),
  ).toEqual({ industryCode: null, keywords: [], missing: [] });
});
