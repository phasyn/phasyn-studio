// 訓練工作的使用者動作：一次送出、不自動重送；成功後用回傳的文件更新快取。
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { LoraTrainingAction } from "@/api/generated/contracts";
import { actOnTraining, trainingKeys } from "./api";

export function useAction(trainingId: string) {
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (body: LoraTrainingAction) => {
    setPending(body.action);
    setError(null);
    try {
      const job = await actOnTraining(trainingId, body);
      client.setQueryData(trainingKeys.one(trainingId), job);
      await client.invalidateQueries({ queryKey: trainingKeys.list() });
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(null);
    }
  };
  return { run, pending, error };
}
