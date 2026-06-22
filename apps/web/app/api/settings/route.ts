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

  const settings = await getUserSettingsByUserId(userId);
  const snapshot = await getModelAvailabilitySnapshot();
  const availablePrimaryModels = snapshot.availablePrimaryModels;

  const resolvedPrimaryModel =
    settings?.primaryModel && availablePrimaryModels.includes(settings.primaryModel)
      ? settings.primaryModel
      : null;

  return NextResponse.json({
    primaryModel: resolvedPrimaryModel,
    personality:
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE,
    availablePrimaryModels,
    modelsError: null,
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
    const { availablePrimaryModels } = await getModelAvailabilitySnapshot();

    if (!availablePrimaryModels.includes(modelInput)) {
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
