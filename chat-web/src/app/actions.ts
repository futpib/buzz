"use server";

import { publishMessage, type SendMessageInput } from "@/server/messages";

export async function sendMessageAction(
  input: SendMessageInput,
): Promise<{ id: string }> {
  return { id: await publishMessage(input) };
}
