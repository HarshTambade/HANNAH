import { useState, type ReactElement } from "react";
import { Braces, Plus, Trash2 } from "lucide-react";
import type { Catalog, ParamSchema } from "../../services/WorkflowApi";

export const fieldClass = "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-ink outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100";
const smallField = "w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-ink outline-none focus:border-violet-400";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MODELS = [
  { value: "auto", label: "Auto (HANNAH picks from your keys)" },
  { value: "groq:openai/gpt-oss-120b", label: "Groq · GPT-OSS 120B" },
  { value: "groq:llama-3.3-70b-versatile", label: "Groq · Llama 3.3 70B" },
  { value: "groq:llama-3.1-8b-instant", label: "Groq · Llama 3.1 8B (fast)" },
  { value: "openai:gpt-4.1-mini", label: "OpenAI · GPT-4.1 mini" },
  { value: "openai:gpt-4.1", label: "OpenAI · GPT-4.1" },
  { value: "anthropic:claude-sonnet-4-5", label: "Anthropic · Claude Sonnet" },
  { value: "gemini:gemini-2.5-flash", label: "Google · Gemini 2.5 Flash" },
];

type Props = {
  param: ParamSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  catalog: Catalog;
  /** Expressions for fields of earlier steps, e.g. {{ $json.amount }}, from the last run. */
  fields: string[];
  error?: string;
};

/** Insert-a-field picker: earlier steps' fields as expressions. */
function FieldInsert({ fields, onInsert }: { fields: string[]; onInsert: (expression: string) => void }) {
  if (!fields.length) return null;
  return (
    <select aria-label="Insert a field from an earlier step" value="" onChange={(event) => { if (event.target.value) onInsert(event.target.value); }} className="max-w-[11rem] rounded-lg border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600">
      <option value="">Insert field…</option>
      {fields.map((field) => <option key={field} value={field}>{field.replace(/^\{\{\s*|\s*\}\}$/g, "")}</option>)}
    </select>
  );
}

function TextInput({ value, onChange, multiline, placeholder, fields, label, code }: { value: string; onChange: (value: string) => void; multiline?: boolean; placeholder?: string; fields: string[]; label: string; code?: boolean }) {
  const props = { value, placeholder, "aria-label": label, onChange: (event: { target: { value: string } }) => onChange(event.target.value), className: `${fieldClass} ${code ? "font-mono text-xs" : ""}` };
  return (
    <div>
      {multiline ? <textarea rows={code ? 5 : 3} spellCheck={!code} {...props} /> : <input {...props} />}
      {fields.length > 0 && <div className="mt-1 flex justify-end"><FieldInsert fields={fields} onInsert={(expression) => onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}${expression}`)} /></div>}
    </div>
  );
}

export default function ParamField({ param, value, onChange, catalog, fields, error }: Props) {
  const [jsonText, setJsonText] = useState(() => (param.type === "json" ? JSON.stringify(value ?? param.default ?? {}, null, 2) : ""));
  const [jsonError, setJsonError] = useState("");
  const id = `param-${param.name}`;
  const label = (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
      {param.label}{param.required && <span className="text-rose-600" aria-hidden="true">*</span>}
      {param.expression && <span title="Accepts {{ expressions }}" className="inline-flex items-center rounded bg-violet-50 px-1 text-[10px] font-semibold text-violet-700"><Braces size={10} />fx</span>}
    </span>
  );
  const help = param.help ? <p className="mt-1 text-[11px] leading-snug text-slate-500">{param.help}</p> : null;
  const problem = error ? <p className="mt-1 text-[11px] font-medium text-rose-700" role="alert">{error}</p> : null;
  const operators = Object.entries(catalog.operators);

  let control: ReactElement;
  switch (param.type) {
    case "boolean":
      return (
        <label className="flex items-start gap-2 text-sm text-ink">
          <input id={id} type="checkbox" className="mt-0.5" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
          <span><span className="font-medium">{param.label}</span>{help}</span>
        </label>
      );
    case "select":
    case "model": {
      const options = param.type === "model" ? MODELS : param.options ?? [];
      control = (
        <select id={id} className={fieldClass} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          {param.type === "model" && Boolean(value) && !options.some((option) => option.value === value) ? <option value={String(value)}>{String(value)}</option> : null}
        </select>
      );
      break;
    }
    case "number":
      control = <input id={id} type="number" className={fieldClass} value={value === undefined || value === null ? "" : String(value)} min={param.min} max={param.max} step={param.step ?? 1} onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))} />;
      break;
    case "text":
    case "code":
      control = <TextInput label={param.label} value={String(value ?? "")} onChange={onChange} multiline code={param.type === "code"} placeholder={param.placeholder} fields={param.expression ? fields : []} />;
      break;
    case "json":
      control = (
        <div>
          <textarea id={id} rows={5} spellCheck={false} className={`${fieldClass} font-mono text-xs`} value={jsonText} onChange={(event) => {
            setJsonText(event.target.value);
            try {
              onChange(event.target.value.trim() ? JSON.parse(event.target.value) : {});
              setJsonError("");
            } catch {
              // Allow a {{ expression }} on its own as the whole body.
              if (/^\s*\{\{[\s\S]*\}\}\s*$/.test(event.target.value)) { onChange(event.target.value.trim()); setJsonError(""); }
              else setJsonError("Not valid JSON yet.");
            }
          }} />
          {jsonError && <p className="mt-1 text-[11px] text-amber-800">{jsonError}</p>}
          {param.expression && fields.length > 0 && <p className="mt-1 text-[11px] text-slate-500">Inside strings you can use expressions, for example {"\"{{ $json.amount }}\""}.</p>}
        </div>
      );
      break;
    case "keyValue": {
      const list = Array.isArray(value) ? (value as Array<{ name: string; value: unknown }>) : [];
      control = (
        <div className="mt-1 space-y-1.5">
          {list.map((entry, index) => (
            <div key={index} className="grid grid-cols-[1fr_1.4fr_auto] gap-1.5">
              <input aria-label={`${param.label} ${index + 1} name`} className={smallField} placeholder="name" value={entry.name} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)))} />
              <input aria-label={`${param.label} ${index + 1} value`} className={smallField} placeholder="value or {{ expression }}" value={String(entry.value ?? "")} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, value: event.target.value } : item)))} />
              <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Remove ${param.label} ${index + 1}`} onClick={() => onChange(list.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => onChange([...list, { name: "", value: "" }])}><Plus size={12} /> Add</button>
            {param.expression && <FieldInsert fields={fields} onInsert={(expression) => onChange([...list, { name: expression.replace(/^\{\{\s*\$json\.?|\s*\}\}$/g, "").replace(/\W+/g, "_") || "field", value: expression }])} />}
          </div>
        </div>
      );
      break;
    }
    case "conditions": {
      const list = Array.isArray(value) ? (value as Array<{ left: string; operator: string; right: string }>) : [];
      control = (
        <div className="mt-1 space-y-1.5">
          {list.map((condition, index) => {
            const unary = catalog.operators[condition.operator]?.unary;
            return (
              <div key={index} className="grid gap-1.5 rounded-xl border border-slate-100 bg-slate-50 p-2 sm:grid-cols-[1.2fr_1fr_1fr_auto]">
                <input aria-label={`Condition ${index + 1} value`} className={smallField} placeholder="{{ $json.amount }}" value={condition.left} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, left: event.target.value } : item)))} />
                <select aria-label={`Condition ${index + 1} comparison`} className={smallField} value={condition.operator} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, operator: event.target.value } : item)))}>
                  {operators.map(([key, operator]) => <option key={key} value={key}>{operator.label}</option>)}
                </select>
                {unary ? <span /> : <input aria-label={`Condition ${index + 1} compared with`} className={smallField} placeholder="1000" value={condition.right ?? ""} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, right: event.target.value } : item)))} />}
                <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Remove condition ${index + 1}`} onClick={() => onChange(list.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
              </div>
            );
          })}
          <div className="flex items-center justify-between">
            <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => onChange([...list, { left: "", operator: "eq", right: "" }])}><Plus size={12} /> Add condition</button>
            <FieldInsert fields={fields} onInsert={(expression) => onChange([...list, { left: expression, operator: "eq", right: "" }])} />
          </div>
        </div>
      );
      break;
    }
    case "rules": {
      const list = Array.isArray(value) ? (value as Array<{ operator: string; right: string }>) : [];
      control = (
        <div className="mt-1 space-y-1.5">
          {list.map((rule, index) => (
            <div key={index} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-500">Output {index + 1}</span>
              <select aria-label={`Rule ${index + 1} comparison`} className={smallField} value={rule.operator} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, operator: event.target.value } : item)))}>
                {operators.map(([key, operator]) => <option key={key} value={key}>{operator.label}</option>)}
              </select>
              <input aria-label={`Rule ${index + 1} value`} className={smallField} value={rule.right ?? ""} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, right: event.target.value } : item)))} />
              <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Remove rule ${index + 1}`} onClick={() => onChange(list.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => onChange([...list, { operator: "eq", right: "" }])}><Plus size={12} /> Add rule</button>
        </div>
      );
      break;
    }
    case "fieldRules": {
      const list = Array.isArray(value) ? (value as Array<{ field: string; type: string; required: boolean }>) : [];
      control = (
        <div className="mt-1 space-y-1.5">
          {list.map((rule, index) => (
            <div key={index} className="grid grid-cols-[1.2fr_1fr_auto_auto] items-center gap-1.5">
              <input aria-label={`Field ${index + 1} name`} className={smallField} placeholder="amount" value={rule.field} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, field: event.target.value } : item)))} />
              <select aria-label={`Field ${index + 1} type`} className={smallField} value={rule.type} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, type: event.target.value } : item)))}>
                {["string", "number", "boolean", "date", "email", "list"].map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <label className="flex items-center gap-1 text-[11px] text-slate-600"><input type="checkbox" checked={rule.required} onChange={(event) => onChange(list.map((item, at) => (at === index ? { ...item, required: event.target.checked } : item)))} />required</label>
              <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Remove field ${index + 1}`} onClick={() => onChange(list.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => onChange([...list, { field: "", type: "string", required: false }])}><Plus size={12} /> Add field</button>
        </div>
      );
      break;
    }
    case "list": {
      const list = Array.isArray(value) ? (value as unknown[]) : [];
      control = (
        <div className="mt-1 space-y-1.5">
          {list.map((entry, index) => (
            <div key={index} className="grid grid-cols-[1fr_auto] gap-1.5">
              <input aria-label={`${param.label} ${index + 1}`} className={smallField} value={String(entry ?? "")} onChange={(event) => onChange(list.map((item, at) => (at === index ? event.target.value : item)))} />
              <button type="button" className="btn-ghost !p-1.5 text-rose-700" aria-label={`Remove ${param.label} ${index + 1}`} onClick={() => onChange(list.filter((_, at) => at !== index))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => onChange([...list, ""])}><Plus size={12} /> Add</button>
        </div>
      );
      break;
    }
    case "days": {
      const days = Array.isArray(value) ? (value as number[]) : [];
      control = (
        <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={param.label}>
          {DAY_NAMES.map((day, index) => {
            const on = days.includes(index);
            return <button key={day} type="button" aria-pressed={on} onClick={() => onChange(on ? days.filter((item) => item !== index) : [...days, index].sort())} className={`rounded-lg border px-2 py-1 text-xs font-semibold ${on ? "border-violet-300 bg-violet-100 text-violet-900" : "border-slate-200 bg-white text-slate-600"}`}>{day}</button>;
          })}
        </div>
      );
      break;
    }
    default:
      control = <TextInput label={param.label} value={String(value ?? "")} onChange={onChange} placeholder={param.placeholder} fields={param.expression ? fields : []} />;
  }
  return (
    <div>
      <label htmlFor={id} className="block">{label}</label>
      {control}
      {help}
      {problem}
    </div>
  );
}
