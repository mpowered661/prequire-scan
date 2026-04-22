import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import {
  SCAN_SYSTEM_PROMPT,
  buildUserPrompt,
  ScanResult,
} from '@/lib/scanPrompt';
import { logScanLead } from '@/lib/supabase/scanLeads';
import { saveScanResult } from '@/lib/supabase/scanResults';

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
          model: 'claude-sonnet-4-5',
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: SCAN_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
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
          controller.enqueue(encode({
            stage: 'error',
            message: 'Analysis failed to parse. Please try again.',
          }));
          controller.close();
          return;
        }

        // Persist full result and get scan_id
        const scanId = await saveScanResult({
          url: normalizedUrl,
          overall_score: result.overallScore,
          result_json: result,
          email: isInternal ? (email ?? null) : null,
          source: isInternal ? 'quinn' : 'public',
          ghl_contact_id: isInternal ? (ghl_contact_id ?? null) : null,
        });

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
