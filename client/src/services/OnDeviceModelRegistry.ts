export type ModelCapability = "chat" | "code" | "reasoning" | "device_status" | "tool_calling" | "speech";

export type LocalModel = {
  id: string;
  name: string;
  family: "webllm" | "llamacpp" | "platform_slm";
  parameterCount: string;
  quantization: string;
  supportedTasks: ModelCapability[];
  memoryFootprintMB: number;
  supportsToolCalling: boolean;
  available: boolean;
};

export const OnDeviceModelRegistry = {
  models: [
    { id: "webllm-llama-3.2-1b", name: "Llama 3.2 1B (WebLLM)", family: "webllm", parameterCount: "1B", quantization: "q4f16", supportedTasks: ["chat", "device_status"], memoryFootprintMB: 900, supportsToolCalling: false, available: false },
    { id: "llamacpp-gguf", name: "llama.cpp GGUF", family: "llamacpp", parameterCount: "varies", quantization: "q4_k_m", supportedTasks: ["chat", "code", "reasoning"], memoryFootprintMB: 2048, supportsToolCalling: true, available: false },
    { id: "platform-slm", name: "Platform SLM", family: "platform_slm", parameterCount: "on-device", quantization: "native", supportedTasks: ["chat", "device_status", "speech"], memoryFootprintMB: 512, supportsToolCalling: false, available: false },
  ] as LocalModel[],
  list() { return this.models; },
  available() { return this.models.filter((model) => model.available); },
  supports(task: ModelCapability) { return this.models.some((model) => model.available && model.supportedTasks.includes(task)); },
  markAvailable(id: string, available: boolean) {
    const model = this.models.find((entry) => entry.id === id);
    if (model) model.available = available;
  },
};