import Dashboard from "@/components/dashboard";

type HomeProps = {
  searchParams?: Promise<{
    q?: string | string[];
  }>;
};

const MAX_INITIAL_PROMPT_LENGTH = 4000;

function normalizeInitialPrompt(value: string | string[] | undefined): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const prompt = rawValue?.trim().slice(0, MAX_INITIAL_PROMPT_LENGTH);
  return prompt || undefined;
}

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;

  return (
    <Dashboard
      landingHero
      startTemporary
      initialTemporaryPrompt={normalizeInitialPrompt(params?.q)}
    />
  );
}
