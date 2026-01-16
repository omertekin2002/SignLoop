import styles from "./page.module.css";
import { SignedIn, SignedOut } from "@clerk/nextjs";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>Welcome to SignLoop</h1>
        <p style={{ fontSize: '1.2rem', color: '#666', marginBottom: '2rem' }}>
          Your fullstack Turborepo application with Clerk authentication.
        </p>

        <SignedIn>
          <div style={{ padding: '20px', border: '1px solid #eaeaea', borderRadius: '8px', textAlign: 'center' }}>
            <h2 style={{ marginBottom: '10px' }}>You are signed in!</h2>
            <p>Access your dashboard or manage your profile using the user button in the header.</p>
          </div>
        </SignedIn>

        <SignedOut>
          <div style={{ padding: '20px', border: '1px solid #eaeaea', borderRadius: '8px', textAlign: 'center' }}>
            <h2 style={{ marginBottom: '10px' }}>Get Started</h2>
            <p>Please sign in to access all features of the application.</p>
          </div>
        </SignedOut>

        <div style={{ marginTop: '3rem', display: 'flex', gap: '1rem' }}>
          <div style={{ flex: 1, padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '12px' }}>
            <h3>Turborepo</h3>
            <p>High-performance build system for JavaScript and TypeScript codebases.</p>
          </div>
          <div style={{ flex: 1, padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '12px' }}>
            <h3>Clerk</h3>
            <p>Complete user management and authentication for Next.js.</p>
          </div>
          <div style={{ flex: 1, padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '12px' }}>
            <h3>Vercel</h3>
            <p>Develop, Preview, and Ship with the best developer experience.</p>
          </div>
        </div>
      </main>
      
      <footer className={styles.footer}>
        <p>© 2026 SignLoop. All rights reserved.</p>
      </footer>
    </div>
  );
}