import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  PRIMARY_MODEL_OPTIONS,
  isAllowedPrimaryModel,
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
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getUserSettingsByUserId(userId);

  return NextResponse.json({
    primaryModel: settings?.primaryModel ?? null,
    personality:
      settings?.personality && isAllowedPersonalityMode(settings.personality)
        ? settings.personality
        : DEFAULT_PERSONALITY_MODE,
    availablePrimaryModels: PRIMARY_MODEL_OPTIONS,
    availablePersonalities: PERSONALITY_OPTIONS,
  });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { primaryModel?: string; personality?: string };
  const modelInput =
    typeof body.primaryModel === "string" ? body.primaryModel.trim() : "";
  const personalityInput =
    typeof body.personality === "string" ? body.personality.trim() : "";

  if (!modelInput && !personalityInput) {
    return NextResponse.json(
      {
        error: "No setting provided",
      },
      { status: 400 },
    );
  }

  let model: PrimaryModel | null = null;
  if (modelInput) {
    if (!isAllowedPrimaryModel(modelInput)) {
      return NextResponse.json(
        {
          error: "Invalid primary model",
          availablePrimaryModels: PRIMARY_MODEL_OPTIONS,
        },
        { status: 400 },
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

  let saved = await getUserSettingsByUserId(userId);

  if (model) {
    saved = await upsertUserPrimaryModel({
      userId,
      primaryModel: model,
    });
  }

  if (personality) {
    saved = await upsertUserPersonality({
      userId,
      personality,
    });
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
