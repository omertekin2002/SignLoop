import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy · SignLoop",
  description: "How SignLoop collects, uses, and shares information.",
};

const ISSUES_URL = "https://github.com/omertekin2002/SignLoop/issues";

/** Explain storage, temporary chats, uploads, and data processing by external providers. */
export default function PrivacyPage() {
  return (
    <div className="app-page">
      <header className="app-header">
        <div className="mx-auto max-w-3xl space-y-3 px-4 pb-6 pt-10 sm:px-6 lg:px-8">
          <p className="app-eyebrow">SignLoop</p>
          <h1 className="app-title">Privacy Policy</h1>
          <p className="app-lede">Last updated October 26, 2026</p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-20 sm:px-6 lg:px-8">
        <article className="prose prose-dala max-w-none prose-headings:font-normal">
          <p>
            SignLoop is a personal, non-commercial project that helps you review contracts with
            AI. This policy explains what information SignLoop collects at{" "}
            <Link href="/">signloop.vercel.app</Link>, how it is used, and who it is shared with.
          </p>

          <h2>Information SignLoop collects</h2>
          <ul>
            <li>
              <strong>Account information.</strong> Sign-in is provided by WorkOS, which stores
              your email address, name, and sign-in method. If you choose Sign in with Google,
              Google shares your name, email address, and profile picture with WorkOS. Passwords
              are handled by WorkOS; SignLoop never sees them. SignLoop’s own database stores
              an internal account ID linked to your WorkOS user ID.
            </li>
            <li>
              <strong>Content you provide.</strong> Contracts and documents you upload, the text
              extracted from them, analyses, projects, saved chat conversations and images, and
              your settings, such as your preferred model.
            </li>
            <li>
              <strong>Temporary chats.</strong> Temporary chats are not saved to SignLoop’s
              database. They stay in your browser, but their messages are still sent to AI
              providers to generate replies.
              Files attached to temporary chats are processed to extract text and then kept
              only in your browser conversation. Saved-chat files and generated downloads
              are kept with the chat and removed when you delete it.
            </li>
            <li>
              <strong>Technical information.</strong> SignLoop’s hosting provider processes
              standard request logs, including IP addresses, to operate the service. SignLoop does
              not store IP addresses and does not use analytics or advertising trackers.
            </li>
          </ul>

          <h2>Cookies and browser storage</h2>
          <p>
            SignLoop uses an encrypted session cookie to keep you signed in and a short-lived
            cookie that protects the sign-in process. Your browser’s local storage remembers
            your theme and whether you have acknowledged the in-app privacy notice. These are
            needed for the service to work; none are used for tracking.
          </p>

          <h2>How information is used</h2>
          <p>Information is used only to:</p>
          <ul>
            <li>sign you in and keep your workspace private to your account;</li>
            <li>store your workspace and generate analyses and chat replies;</li>
            <li>enforce usage limits, using a one-way hash of your account ID; and</li>
            <li>keep the service secure and working.</li>
          </ul>
          <p>
            SignLoop does not sell your information, use it for advertising, or train its own
            models on it.
          </p>

          <h2>Who information is shared with</h2>
          <p>
            SignLoop relies on the service providers below. Each handles data under its own
            privacy policy, and some may process it in the United States or other countries.
          </p>
          <ul>
            <li>
              <strong>WorkOS</strong>: account sign-in and management.
            </li>
            <li>
              <strong>Google</strong>: only if you choose Sign in with Google.
            </li>
            <li>
              <strong>Vercel</strong>: hosting, and private storage of uploaded files.
            </li>
            <li>
              <strong>Neon</strong>: the database that stores your workspace.
            </li>
            <li>
              <strong>AI model providers.</strong> To produce analyses and replies, your messages,
              document text, and images are sent to AI models. Requests go through a model gateway
              run by SignLoop’s developer, reached through ngrok’s tunneling service, and
              may be routed to providers such as Google Gemini. OpenRouter is used as a fallback
              and forwards requests to third-party model providers. Some providers, especially
              for free models, may log your prompts, use them to train models, or publish them.
            </li>
            <li>
              <strong>Langfuse (optional diagnostics).</strong> AI chat tracing is disabled by
              default. If the operator explicitly enables content recording, saved-chat prompts,
              replies, and tool inputs/results may be recorded in Langfuse. Temporary chats do
              not enable AI tracing. Trace retention is configured separately by the operator;
              deleting a workspace item or your account does not automatically delete
              previously collected traces.
            </li>
            <li>
              <strong>Web search and page reading.</strong> When the assistant searches the web or
              reads a page, search queries and page addresses are sent to Firecrawl, Google
              Gemini with Google Search, or Jina Reader. The assistant may also fetch public web
              pages directly.
            </li>
          </ul>
          <p>
            Because of this, do not upload information you cannot share with these providers.
            Redact personal and sensitive details before using SignLoop.
          </p>

          <h2>Information from Google</h2>
          <p>
            Sign in with Google gives SignLoop only your basic profile: your name, email address,
            and profile picture. SignLoop does not request access to Gmail, Google Drive, Google
            Calendar, or any other Google service, and does not receive Google access tokens. This
            information is used only to sign you in and is never sold or used for advertising.
            SignLoop’s use of information received from Google APIs adheres to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>

          <h2>Getting a copy of your data</h2>
          <p>
            To download everything in your account, sign in and choose{" "}
            <strong>Download my data</strong> in <Link href="/settings" prefetch={false}>Settings</Link>.
            You get one ZIP file with your contracts and their extracted text, analyses, projects,
            reference documents, saved chats with their messages, and settings as JSON, plus the
            original files you uploaded and the files and images in your saved chats, exactly as
            they were stored. Temporary chats are not included, because SignLoop never stores them.
          </p>

          <h2>Retention and deletion</h2>
          <p>
            Your workspace is kept until you delete it. You can delete contracts, analyses,
            projects, reference documents, and saved chats in the app. Deleting removes the
            database records immediately; stored files are removed by a cleanup job that runs
            daily. Providers’ own logs and backups may persist for limited periods under their
            policies.
          </p>
          <p>
            To delete your account entirely, sign in and choose <strong>Delete account</strong>{" "}
            in <Link href="/settings" prefetch={false}>Settings</Link>. This immediately and permanently deletes
            your contracts, uploaded files, analyses, projects, reference documents, saved chats
            with their images and files, settings, SignLoop’s internal account ID, and your WorkOS
            sign-in account, and signs you out. Uploaded files are erased from storage by the
            cleanup job, which runs daily, usually within a day. It cannot be undone. Temporary
            chats stay in your browser until you clear them.
          </p>

          <h2>Security</h2>
          <p>
            Connections to SignLoop use HTTPS, session cookies are encrypted, and workspace data
            is scoped to your account. No system is perfectly secure, so avoid uploading
            information whose exposure would cause serious harm.
          </p>

          <h2>Children</h2>
          <p>SignLoop is not intended for children under 16.</p>

          <h2>Changes to this policy</h2>
          <p>
            Updates will be posted on this page with a new “Last updated” date.
          </p>

          <h2>Contact</h2>
          <p>
            For privacy questions or requests, open an issue on{" "}
            <a href={ISSUES_URL}>SignLoop’s GitHub repository</a>.
          </p>
        </article>
      </main>
    </div>
  );
}
