import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertRuleSchema, AlertRulesResponseSchema, ChannelTestResponseSchema, IncidentsResponseSchema, NotificationChannelSchema, NotificationChannelsResponseSchema,
  type AlertRuleInput, type AlertRulePatch, type ChannelInput,
} from "@sysmon/protocol";
import { z } from "zod";
import { apiFetch } from "./client";

export const alertKeys = {
  rules: ["alert-rules"] as const,
  channels: ["notification-channels"] as const,
  incidents: (state: "open" | "resolved") => ["incidents", state] as const,
};

const NoContent = z.undefined();

export const useAlertRules = () =>
  useQuery({ queryKey: alertKeys.rules, queryFn: ({ signal }) => apiFetch("/api/v1/alert-rules", AlertRulesResponseSchema, { signal }) });

export const useChannels = () =>
  useQuery({ queryKey: alertKeys.channels, queryFn: ({ signal }) => apiFetch("/api/v1/notification-channels", NotificationChannelsResponseSchema, { signal }) });

export const useIncidents = (state: "open" | "resolved") =>
  useQuery({ queryKey: alertKeys.incidents(state), queryFn: ({ signal }) => apiFetch(`/api/v1/incidents?state=${state}&limit=100`, IncidentsResponseSchema, { signal }) });

/** Mutasyonlar ilgili listeleri gecersiz kilar. Kanal olusturma yaniti SIR icermez (yalniz ozet); form alanlari basari sonrasi sifirlanir. */
export function useAlertMutations() {
  const qc = useQueryClient();
  const refresh = (...keys: readonly (readonly unknown[])[]) => () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
  return {
    createRule: useMutation({ mutationFn: (v: AlertRuleInput) => apiFetch("/api/v1/alert-rules", AlertRuleSchema, { method: "POST", json: v }), onSuccess: refresh(alertKeys.rules) }),
    patchRule: useMutation({ mutationFn: (v: { id: string; patch: AlertRulePatch }) => apiFetch(`/api/v1/alert-rules/${v.id}`, AlertRuleSchema, { method: "PATCH", json: v.patch }), onSuccess: refresh(alertKeys.rules) }),
    deleteRule: useMutation({ mutationFn: (id: string) => apiFetch(`/api/v1/alert-rules/${id}`, NoContent, { method: "DELETE" }), onSuccess: refresh(alertKeys.rules, ["incidents"]) }),
    createChannel: useMutation({ gcTime: 0, mutationFn: (v: ChannelInput) => apiFetch("/api/v1/notification-channels", NotificationChannelSchema, { method: "POST", json: v }), onSuccess: refresh(alertKeys.channels) }),
    deleteChannel: useMutation({ mutationFn: (id: string) => apiFetch(`/api/v1/notification-channels/${id}`, NoContent, { method: "DELETE" }), onSuccess: refresh(alertKeys.channels, alertKeys.rules) }),
    testChannel: useMutation({ mutationFn: (id: string) => apiFetch(`/api/v1/notification-channels/${id}/test`, ChannelTestResponseSchema, { method: "POST" }) }),
  };
}
