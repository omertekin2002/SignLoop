import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { PRIMARY_MODEL_OPTIONS, isAllowedPrimaryModel } from "@/lib/model-settings";
import { getUserSettingsByUserId, upsertUserPrimaryModel } from "@/lib/server-db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getUserSettingsByUserId(userId);

  return NextResponse.json({
    primaryModel: settings?.primaryModel ?? null,
    availablePrimaryModels: PRIMARY_MODEL_OPTIONS,
  });
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as { primaryModel?: string };
  const model = typeof body.primaryModel === "string" ? body.primaryModel.trim() : "";

  if (!model || !isAllowedPrimaryModel(model)) {
    return NextResponse.json(
      {
        error: "Invalid primary model",
        availablePrimaryModels: PRIMARY_MODEL_OPTIONS,
      },
      { status: 400 },
    );
  }

  const saved = await upsertUserPrimaryModel({
    userId,
    primaryModel: model,
  });

  return NextResponse.json({
    primaryModel: saved.primaryModel,
    updatedAt: saved.updatedAt,
  });
}

