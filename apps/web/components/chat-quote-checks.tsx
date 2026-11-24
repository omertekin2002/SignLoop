"use client";

import { useId, useMemo } from "react";
import { useMessage } from "@assistant-ui/react";
import { AlertTriangle, CircleCheck } from "lucide-react";
import {
  parseChatQuoteChecks,
  type QuoteCheck,
} from "@/lib/chat-quote-checks";

/** Long quotations are shortened in their row; the reply above shows them whole. */
export const QUOTE_ROW_LENGTH = 160;

export const QUOTE_FOUND_LABEL = "Found in the contract";
export const QUOTE_NOT_FOUND_LABEL =
  "Not found in the contract: check the wording against the original";

function shorten(quote: string): string {
  const chars = Array.from(quote);
  return chars.length > QUOTE_ROW_LENGTH
    ? `${chars.slice(0, QUOTE_ROW_LENGTH - 1).join("").trimEnd()}…`
    : quote;
}

/**
 * One row per quotation in a reply about a contract, saying whether its words appear in that
 * contract. The label says only that: a found quotation shows where the words come from, not that
 * the answer reads them correctly. Each row has an icon and its label, never colour alone.
 */
export function QuoteChecksList({ checks }: { checks: readonly QuoteCheck[] }) {
  const headingId = useId();
  if (!checks.length) return null;
  return (
    <div className="my-2 max-w-2xl rounded-card border border-border px-4 py-3">
      <p
        id={headingId}
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        Quotations
      </p>
      <ul aria-labelledby={headingId} className="mt-2 space-y-2">
        {checks.map((check, index) => {
          const found = check.status === "found";
          return (
            <li key={index} className="flex items-start gap-2 text-sm">
              {found ? (
                <CircleCheck
                  className="mt-0.5 h-4 w-4 shrink-0 text-success"
                  aria-hidden
                />
              ) : (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-highlight"
                  aria-hidden
                />
              )}
              <div className="min-w-0 space-y-0.5">
                <q className="block break-words text-subtle-foreground">
                  {shorten(check.quote)}
                </q>
                <p className="text-xs text-muted-foreground">
                  {found ? QUOTE_FOUND_LABEL : QUOTE_NOT_FOUND_LABEL}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The checked quotations stored with an assistant reply, if it was about a contract and quoted any. */
export function MessageQuoteChecks() {
  const value = useMessage((message) => message.metadata.custom?.quoteChecks);
  const checks = useMemo(() => parseChatQuoteChecks(value)?.checks ?? [], [value]);
  return <QuoteChecksList checks={checks} />;
}
