/**
 * Clause categories for gold annotations, with aliases that map the model's free-text
 * `red_flags[].type` labels onto them.
 *
 * Category names follow CUAD (Hendrycks et al., 2021, CC BY 4.0) and UNFAIR-ToS (Lippi et al.,
 * 2019, distributed in LexGLUE) where they overlap; "SignLoop" marks additions for consumer and
 * small-business agreements. Only label names are borrowed; no dataset text is included.
 *
 * Alias matching is a heuristic used for label recall and negative controls. The headline clause
 * recall is span-based and never depends on it.
 */
export const CLAUSE_CATEGORIES = [
  "auto_renewal",
  "cancellation_notice",
  "termination_for_convenience",
  "unilateral_termination",
  "unilateral_change",
  "price_increase",
  "early_termination_fee",
  "liquidated_damages",
  "late_payment",
  "non_refundable",
  "limitation_of_liability",
  "uncapped_liability",
  "indemnification",
  "arbitration",
  "jurisdiction",
  "governing_law",
  "contract_by_using",
  "non_solicitation",
  "non_compete",
  "exclusivity",
  "anti_assignment",
  "ip_ownership",
  "audit_rights",
  "insurance",
  "minimum_commitment",
] as const;

export type ClauseCategory = (typeof CLAUSE_CATEGORIES)[number];

type CategoryDefinition = {
  source: string;
  /** Matched against normalized labels: lower case, words separated by single spaces. */
  aliases: readonly RegExp[];
};

export const TAXONOMY: Record<ClauseCategory, CategoryDefinition> = {
  auto_renewal: {
    source: "CUAD: Renewal Term",
    aliases: [
      /\bauto ?renew/,
      /\bautomatic(?:ally)? renew/,
      /\brenews? automatically\b/,
      /\bevergreen\b/,
      /\broll ?over\b/,
      /\bmonth to month\b/,
    ],
  },
  cancellation_notice: {
    source: "CUAD: Notice Period to Terminate Renewal",
    aliases: [
      /\bnotice (?:period|deadline|requirement)/,
      /\bnon ?renewal\b/,
      /\bcancell?ation (?:notice|deadline|window|period|requirement)/,
      /\btermination notice\b/,
      /\bnotice (?:to|of|for) (?:cancel|terminat|non ?renew)/,
    ],
  },
  termination_for_convenience: {
    source: "CUAD: Termination for Convenience",
    aliases: [
      /\bterminat\w* for convenience\b/,
      /\bconvenience terminat/,
      /\bterminat\w* without cause\b/,
      /\bterminat\w* (?:at any time|for any reason)\b/,
    ],
  },
  unilateral_termination: {
    source: "UNFAIR-ToS: Unilateral termination",
    aliases: [
      /\bunilateral terminat/,
      /\bterminat\w* at (?:its|their) (?:sole )?discretion\b/,
      /\bsuspen(?:d|sion)\b/,
    ],
  },
  unilateral_change: {
    source: "UNFAIR-ToS: Unilateral change",
    aliases: [
      /\bunilateral (?:change|amendment|modification|variation)/,
      /\bchange[sd]? (?:to )?(?:the )?terms\b/,
      /\bmodif\w* (?:of )?(?:the )?terms\b/,
      /\bamend\w* (?:at any time|unilaterally)\b/,
    ],
  },
  price_increase: {
    source: "SignLoop",
    aliases: [
      /\bprice (?:increase|escalat|change|adjust)/,
      /\b(?:fee|rate|rent) (?:increase|escalat|adjust)/,
      /\bescalator\b/,
      /\bincrease[sd]? (?:in |to |of )?(?:the )?(?:fees?|prices?|rates?|rent)\b/,
    ],
  },
  early_termination_fee: {
    source: "SignLoop (CUAD: Liquidated Damages is the closest)",
    aliases: [
      /\bearly (?:termination|cancell?ation|exit|return)\b/,
      /\b(?:termination|cancell?ation|exit|kill) (?:fee|charge|penalt)/,
      /\bremaining (?:fees|payments|rent|dues)\b/,
    ],
  },
  liquidated_damages: {
    source: "CUAD: Liquidated Damages",
    aliases: [
      /\bliquidated damages\b/,
      /\b(?:placement|conversion|buyout) fee\b/,
      /\bpenalty clause\b/,
    ],
  },
  late_payment: {
    source: "SignLoop",
    aliases: [
      /\blate (?:payment|fee|charge)/,
      /\binterest on (?:late|overdue)/,
      /\boverdue (?:interest|amounts?|payments?)\b/,
      /\bdefault interest\b/,
    ],
  },
  non_refundable: {
    source: "SignLoop",
    aliases: [
      /\bnon ?refundable\b/,
      /\bno refunds?\b/,
      /\brefund (?:policy|restriction)/,
    ],
  },
  limitation_of_liability: {
    source: "UNFAIR-ToS: Limitation of liability; CUAD: Cap on Liability",
    aliases: [
      /\blimitation of liability\b/,
      /\bliability (?:cap|limit)/,
      /\b(?:cap|limit)\w* (?:on |of )?liability\b/,
      /\bexclusion of (?:liability|damages)\b/,
      /\bconsequential damages\b/,
    ],
  },
  uncapped_liability: {
    source: "CUAD: Uncapped Liability",
    aliases: [
      /\buncapped\b/,
      /\bunlimited liability\b/,
      /\bno (?:liability )?cap\b/,
    ],
  },
  indemnification: {
    source: "SignLoop",
    aliases: [/\bindemni/, /\bhold harmless\b/],
  },
  arbitration: {
    source: "UNFAIR-ToS: Arbitration",
    aliases: [/\barbitrat/, /\bclass action\b/, /\bjury (?:trial )?waiver\b/],
  },
  jurisdiction: {
    source: "UNFAIR-ToS: Jurisdiction",
    aliases: [/\bjurisdiction\b/, /\bvenue\b/, /\bforum\b/],
  },
  governing_law: {
    source: "CUAD: Governing Law; UNFAIR-ToS: Choice of law",
    aliases: [/\bgoverning law\b/, /\bchoice of law\b/, /\bapplicable law\b/],
  },
  contract_by_using: {
    source: "UNFAIR-ToS: Contract by using",
    aliases: [
      /\bcontract by using\b/,
      /\bacceptance by (?:use|using|conduct)\b/,
      /\bdeemed accept/,
      /\bbrowse ?wrap\b/,
    ],
  },
  non_solicitation: {
    source: "CUAD: No-Solicit of Employees",
    aliases: [
      /\bnon ?solicit/,
      /\bno ?solicit/,
      /\b(?:no|non) ?hire\b/,
      /\bsolicitation of (?:employees|staff|personnel)\b/,
    ],
  },
  non_compete: {
    source: "CUAD: Non-Compete",
    aliases: [/\bnon ?compet/, /\brestrictive covenant/],
  },
  exclusivity: {
    source: "CUAD: Exclusivity",
    aliases: [/\bexclusiv/],
  },
  anti_assignment: {
    source: "CUAD: Anti-Assignment",
    aliases: [
      /\banti ?assignment\b/,
      /\bassignment restriction/,
      /\bnon ?assignab/,
      /\bconsent to assign/,
      /\bchange of control\b/,
    ],
  },
  ip_ownership: {
    source: "CUAD: IP Ownership Assignment",
    aliases: [
      /\bintellectual property\b/,
      /\bip (?:ownership|assignment|rights)\b/,
      /\bownership of (?:the )?(?:work|deliverables|ip|materials)\b/,
      /\bwork (?:made )?for hire\b/,
      /\bcopyright\b/,
    ],
  },
  audit_rights: {
    source: "CUAD: Audit Rights",
    aliases: [/\baudit\b/],
  },
  insurance: {
    source: "CUAD: Insurance",
    aliases: [/\binsurance\b/],
  },
  minimum_commitment: {
    source: "CUAD: Minimum Commitment",
    aliases: [
      /\bminimum (?:commitment|purchase|spend|volume)\b/,
      /\btake or pay\b/,
    ],
  },
};

export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim();
}

// "No automatic renewal" states an absence; it must not count as flagging that clause. One word
// may sit between the negation and the alias ("no clear automatic renewal").
const NEGATED_PREFIX =
  /(?:^|\s)(?:no|not|without|lacks?|lack of|absence of|absent|missing|never)\s(?:\S+\s)?$/;

/** Categories a free-text flag label names, in taxonomy order. */
export function resolveCategories(label: string): ClauseCategory[] {
  const normalized = normalizeLabel(label);
  return CLAUSE_CATEGORIES.filter((category) =>
    TAXONOMY[category].aliases.some((alias) => {
      const pattern = new RegExp(alias.source, "g");
      for (const match of normalized.matchAll(pattern)) {
        if (!NEGATED_PREFIX.test(normalized.slice(0, match.index))) return true;
      }
      return false;
    }),
  );
}
