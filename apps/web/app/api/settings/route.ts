import { NextResponse } from "next/server";
import { parseJsonBody, requireUserId } from "@/lib/api-auth";
import {
  getModelAvailabilitySnapshot,
  type PrimaryModel,
} from "@/lib/model-settings";
import {
  DEFAULT_PERSONALITY_MODE,
  PERSONALITY_OPTIONS,
  type PersonalityMode,
  isAllowedPersonalityMode,
} from "@/lib/personality-settings";
import {
  getUserSettingsByUserId,
  upsertUserPersonality,
  upsertUserPrimaryModel,
} from "@/lib/server-db";

export async function GET() {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  // The DB read and the (cached) model-availability lookup are independent — run them concurrently.
  const [settings, snapshot] = await Promise.all([
    getUserSettingsByUserId(userId),
    getModelAvailabilitySnapshot(),
  ]);
  const availablePrimaryModels = snapshot.availablePrimaryModels;

  // When the availability lookup failed (ngrok down), trust the saved model rather than resetting
  // the user's selection to null just because we couldn't fetch the list.
  const resolvedPrimaryModel = settings?.primaryModel
    ? snapshot.error || availablePrimaryModels.includes(settings.primaryModel)
      ? settings.primaryModel
      : null
    : null;

  return NextResponse.json({
    primaryModel: resolvedPrimaryModel,
    personality:
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE,
    availablePrimaryModels,
    availablePersonalities: PERSONALITY_OPTIONS,
  });
}

export async function PUT(req: Request) {
  const authed = await requireUserId();
  if (authed instanceof NextResponse) return authed;
  const { userId } = authed;

  const body = await parseJsonBody<{ primaryModel?: string; personality?: string }>(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const modelInput =
    typeof body.primaryModel === "string" ? body.primaryModel.trim() : "";
  const personalityInput =
    typeof body.personality === "string" ? body.personality.trim() : "";

  if (!modelInput && !personalityInput) {
    return NextResponse.json({ error: "No setting provided" }, { status: 400 });
  }

  let model: PrimaryModel | null = null;
  if (modelInput) {
    const { availablePrimaryModels, error: snapshotError } = await getModelAvailabilitySnapshot();

    // Only reject an unavailable model when we actually have a model list to check against. During
    // an ngrok outage (snapshotError) we can't validate, so accept the save rather than 409.
    if (!snapshotError && !availablePrimaryModels.includes(modelInput)) {
      return NextResponse.json(
        {
          error: "Selected primary model is not currently available",
          availablePrimaryModels,
        },
        { status: 409 },
      );
    }

    model = modelInput;
  }

  let personality: PersonalityMode | null = null;
  if (personalityInput) {
    if (!isAllowedPersonalityMode(personalityInput)) {
      return NextResponse.json(
        {
          error: "Invalid personality",
          availablePersonalities: PERSONALITY_OPTIONS,
        },
        { status: 400 },
      );
    }
    personality = personalityInput;
  }

  // Each upsert returns the full saved row, so we only read what we write (no eager pre-fetch).
  let saved: Awaited<ReturnType<typeof getUserSettingsByUserId>> = null;

  if (model) {
    saved = await upsertUserPrimaryModel({ userId, primaryModel: model });
  }

  if (personality) {
    saved = await upsertUserPersonality({ userId, personality });
  }

  if (!saved) {
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }

  return NextResponse.json({
    primaryModel: saved.primaryModel,
    personality: saved.personality ?? DEFAULT_PERSONALITY_MODE,
    updatedAt: saved.updatedAt,
  });
}
