import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  SCAN_SYSTEM_PROMPT,
  SCAN_PROMPT_VERSION,
  buildUserPrompt,
  computeOverallScore,
  ScanResult,
} from '@/lib/scanPrompt';
import { resolveStudyAuth, buildStudyEnvelope } from '@/lib/study';
import { logScanLead } from '@/lib/supabase/scanLeads';
import { saveScanResult } from '@/lib/supabase/scanResults';

const SCAN_MODEL = 'claude-haiku-4-5-20251001';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

function encode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + '\n');
}

export async function POST(req: NextRequest) {
  // Check for internal token — Quinn calls include X-Internal-Token
  const internalToken = req.headers.get('x-internal-token');
  const isInternal =
    !!internalToken &&
    !!process.env.SCAN_INTERNAL_TOKEN &&
    internalToken === process.env.SCAN_INTERNAL_TOKEN;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await req.json();
        const {
          url,
          email,
          ghl_contact_id,
          utm_source,
          utm_medium,
          utm_campaign,
          utm_content,
          utm_term,
        } = body;

        if (!url || typeof url !== 'string') {
          controller.enqueue(encode({ stage: 'error', message: 'url is required' }));
          controller.close();
          return;
        }

        // Study mode: identical analysis, zero production side effects.
        // Fail-closed — a study request with a missing/invalid token errors
        // rather than silently running with persistence.
        const studyAuth = resolveStudyAuth(
          body.study,
          req.headers.get('x-study-token'),
          process.env.STUDY_MODE_TOKEN,
        );
        if (studyAuth === 'rejected') {
          controller.enqueue(encode({ stage: 'error', message: 'Study mode unavailable.' }));
          controller.close();
          return;
        }
        const isStudy = studyAuth === 'authorized';

        // Normalize URL
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
        } catch {
          controller.enqueue(encode({ stage: 'error', message: 'Invalid URL' }));
          controller.close();
          return;
        }
        const normalizedUrl = parsedUrl.toString();

        // Stage 1 — fetching
        controller.enqueue(encode({ stage: 'fetching', message: 'Fetching page content...' }));

        let html = '';
        try {
          const fetchRes = await fetch(normalizedUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; PrequireAEOScanner/1.0)',
              Accept: 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (!fetchRes.ok) {
            controller.enqueue(encode({
              stage: 'error',
              message: `Could not fetch page (HTTP ${fetchRes.status}). The site may block bots.`,
            }));
            controller.close();
            return;
          }
          html = await fetchRes.text();
        } catch {
          controller.enqueue(encode({
            stage: 'error',
            message: 'Could not reach the URL. Check it is publicly accessible.',
          }));
          controller.close();
          return;
        }

        // Stage 2 — analyzing
        controller.enqueue(encode({ stage: 'analyzing', message: 'Analyzing with Claude...' }));

        const response = await anthropic.messages.create({
          model: SCAN_MODEL,
          max_tokens: 8192,
          temperature: 0, // pin for scoring consistency — reduces run-to-run score variance
          system: SCAN_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: buildUserPrompt(normalizedUrl, html),
            },
          ],
        });

        const rawText =
          response.content.find((b) => b.type === 'text')?.text ?? '';

        // Stage 3 — scoring
        controller.enqueue(encode({ stage: 'scoring', message: 'Calculating AEO score...' }));

        let result: ScanResult;
        try {
          const cleaned = rawText
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();
          result = JSON.parse(cleaned) as ScanResult;
        } catch {
          console.error('[scan] JSON parse failed. stop_reason:', response.stop_reason, 'raw:', rawText.slice(0, 300));
          controller.enqueue(encode({
            stage: 'error',
            message: 'Analysis failed to parse. Please try again.',
          }));
          controller.close();
          return;
        }

        // The model's own overallScore is never trusted: recompute server-side
        // from contentQuality/schemaMarkup/performance. Accessibility signals
        // (LLM-judged from static HTML) are excluded from the overall score.
        result.overallScore = computeOverallScore(result.categories);
        result.scan_meta = {
          prompt_version: SCAN_PROMPT_VERSION,
          model: SCAN_MODEL,
          overall_score_basis: 'content_schema_performance_mean',
        };

        if (isStudy) {
          // No persistence, no lead, no email, no GHL linkage, no workflows.
          controller.enqueue(encode({
            stage: 'complete',
            data: {
              result,
              url: normalizedUrl,
              scan_id: null,
              study: buildStudyEnvelope(normalizedUrl, html, {
                prompt_version: SCAN_PROMPT_VERSION,
                model: SCAN_MODEL,
              }),
            },
          }));
          controller.close();
          return;
        }

        // Persist full result and get scan_id (non-blocking — missing table won't kill scan)
        let scanId: string | null = null;
        try {
          // email persists for public scans too (Sprint 2 A): it is the join key
          // that lets first-run project import find "the scan this account ran".
          // scan_results is deny-all RLS (service-role only), so this adds no
          // client-readable PII surface.
          scanId = await saveScanResult({
            url: normalizedUrl,
            overall_score: result.overallScore,
            result_json: result,
            email: email ?? null,
            source: isInternal ? 'quinn' : 'public',
            ghl_contact_id: isInternal ? (ghl_contact_id ?? null) : null,
          });
        } catch (persistErr) {
          console.error('[scan] saveScanResult failed (non-fatal):', persistErr);
        }

        // Log lead to scan_leads (existing table — non-blocking)
        logScanLead({
          url: normalizedUrl,
          overall_score: result.overallScore,
          utm_source,
          utm_medium,
          utm_campaign,
          utm_content,
          utm_term,
        });

        // Stage 4 — complete
        controller.enqueue(encode({
          stage: 'complete',
          data: {
            result,
            url: normalizedUrl,
            scan_id: scanId,
          },
        }));
        controller.close();
      } catch (err) {
        console.error('[scan API] caught error:', err);
        controller.enqueue(encode({
          stage: 'error',
          message: 'Internal server error. Please try again.',
        }));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'X-Accel-Buffering': 'no',
    },
  });
}
