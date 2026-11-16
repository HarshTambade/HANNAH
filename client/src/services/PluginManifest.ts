import { z } from "zod";

export const PluginPermissionSchema = z.enum([
  "network",
  "filesystem",
  "shell",
  "memory_read",
  "memory_write",
  "tool_execute",
  "mcp_server",
]);

export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginManifestSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  author: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
  permissions: z.array(PluginPermissionSchema).default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: z.array(z.object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).default([]),
  })).default([]),
  entryPoint: z.string().optional(),
  minHannahVersion: z.string().optional(),
  repository: z.string().url().optional(),
  license: z.string().optional(),
  icon: z.string().optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const InstalledPluginSchema = PluginManifestSchema.extend({
  installedAt: z.string(),
  enabled: z.boolean().default(true),
  sourceUrl: z.string().optional(),
});

export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

export const PluginValidationResult = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  manifest: PluginManifestSchema.optional(),
});

export type PluginValidation = z.infer<typeof PluginValidationResult>;
