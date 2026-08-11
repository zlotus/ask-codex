import {
  Check,
  CheckCheck,
  ExternalLink,
  FileCode2,
  HelpCircle,
  ShieldAlert,
  Terminal,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { PendingRequest } from "../types/protocol";
import { commandText, isRecord, parseQuestions, readString } from "../utils/protocol";

interface ApprovalPanelProps {
  requests: PendingRequest[];
  onResolve: (id: string | number, result: unknown) => void;
  onReject: (id: string | number, message: string) => void;
}

interface RequestCardProps {
  request: PendingRequest;
  onResolve: ApprovalPanelProps["onResolve"];
}

function ApprovalRequest({
  request,
  onResolve,
  onReject,
}: RequestCardProps & Pick<ApprovalPanelProps, "onReject">) {
  const isFile = request.method === "item/fileChange/requestApproval" || request.method === "applyPatchApproval";
  const legacy = request.method === "execCommandApproval" || request.method === "applyPatchApproval";
  const decisions = legacy
    ? { accept: "approved", session: "approved_for_session", decline: "abort", cancel: "abort" }
    : { accept: "accept", session: "acceptForSession", decline: "decline", cancel: "cancel" };
  const command = commandText({ id: "request", type: "commandExecution", ...request.params });
  const reason = readString(request.params.reason);
  const availableDecisions = Array.isArray(request.params.availableDecisions)
    ? request.params.availableDecisions.filter((decision): decision is string => typeof decision === "string")
    : null;
  const decisionIsAvailable = (decision: string) => !availableDecisions || availableDecisions.includes(decision);
  const rejectionDecision = decisionIsAvailable(decisions.decline)
    ? decisions.decline
    : decisionIsAvailable(decisions.cancel) ? decisions.cancel : null;
  const rejectionLabel = rejectionDecision === decisions.decline ? "Decline" : "Cancel";
  const grantRoot = isFile ? readString(request.params.grantRoot) : undefined;
  const context = Object.fromEntries(Object.entries(request.params).filter(([key, value]) => (
    value !== undefined &&
    value !== null &&
    !["threadId", "turnId", "conversationId", "itemId", "callId", "approvalId", "startedAtMs", "reason", "command", "availableDecisions"].includes(key)
  )));
  const hasContext = Object.keys(context).length > 0;
  const hasBody = !isFile || Boolean(grantRoot) || hasContext;
  return (
    <section className="approval-card" aria-label={isFile ? "File change approval" : "Command approval"}>
      <div className="approval-card-header">
        <div className="approval-title">
          {isFile ? <FileCode2 size={17} aria-hidden="true" /> : <Terminal size={17} aria-hidden="true" />}
          <div>
            <strong>{isFile ? "Apply file changes?" : "Run this command?"}</strong>
            {reason && <p>{reason}</p>}
          </div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          {decisionIsAvailable(decisions.session) && (
            <button
              type="button"
              className="button button--quiet approval-action-button"
              title="Accept for session"
              aria-label="Accept for session"
              onClick={() => onResolve(request.id, { decision: decisions.session })}
            >
              <CheckCheck size={16} aria-hidden="true" />
            </button>
          )}
          {decisionIsAvailable(decisions.accept) && (
            <button
              type="button"
              className="button button--primary approval-action-button"
              title="Accept"
              aria-label="Accept"
              onClick={() => onResolve(request.id, { decision: decisions.accept })}
            >
              <Check size={16} aria-hidden="true" />
            </button>
          )}
          {rejectionDecision ? (
            <button
              type="button"
              className="button button--danger approval-action-button"
              title={rejectionLabel}
              aria-label={rejectionLabel}
              onClick={() => onResolve(request.id, { decision: rejectionDecision })}
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="button button--danger approval-action-button"
              title="Reject request"
              aria-label="Reject request"
              onClick={() => onReject(request.id, `Ask Codex cannot return any offered decision for ${request.method}`)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {hasBody && (
        <div className="approval-body">
          {!isFile && <pre className="approval-command"><code>{command}</code></pre>}
          {grantRoot && <p className="approval-path"><code>{grantRoot}</code></p>}
          {hasContext && (
            <div className="approval-context">
              <span>Request details</span>
              <pre>{JSON.stringify(context, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function QuestionRequest({ request, onResolve }: RequestCardProps) {
  const questions = useMemo(() => parseQuestions(request.params), [request.params]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete = questions.length > 0 && questions.every((question) => Boolean(answers[question.id]?.trim()));

  const submit = () => {
    const payload = Object.fromEntries(
      questions.map((question) => [question.id, { answers: [answers[question.id].trim()] }]),
    );
    onResolve(request.id, { answers: payload });
  };

  return (
    <section className="approval-card question-card" aria-label="Codex question">
      <div className="approval-title">
        <HelpCircle size={17} aria-hidden="true" />
        <div><strong>Codex needs your input</strong></div>
      </div>
      {questions.map((question) => (
        <fieldset key={question.id} className="question-field">
          {question.header && <span className="question-header">{question.header}</span>}
          <legend>{question.question}</legend>
          {question.options && question.options.length > 0 ? (
            <div className="question-options">
              {question.options.map((option) => (
                <label key={option.label} className="question-option">
                  <input
                    type="radio"
                    name={`${request.id}-${question.id}`}
                    value={option.label}
                    checked={answers[question.id] === option.label}
                    onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                  />
                  <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                </label>
              ))}
              {question.isOther && (
                <input
                  className="text-input"
                  aria-label={`Other answer for ${question.question}`}
                  placeholder="Other answer"
                  value={question.options.some((option) => option.label === answers[question.id]) ? "" : answers[question.id] ?? ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                />
              )}
            </div>
          ) : (
            question.isSecret ? (
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                value={answers[question.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              />
            ) : (
              <textarea
                className="question-textarea"
                rows={3}
                value={answers[question.id] ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              />
            )
          )}
        </fieldset>
      ))}
      <div className="approval-actions">
        <button type="button" className="button button--primary" disabled={!complete} onClick={submit}>
          <Check size={15} aria-hidden="true" />Submit
        </button>
      </div>
    </section>
  );
}

function GenericRequest({ request, onReject }: RequestCardProps & Pick<ApprovalPanelProps, "onReject">) {
  return (
    <section className="approval-card">
      <div className="approval-card-header">
        <div className="approval-title">
          <ShieldAlert size={17} aria-hidden="true" />
          <div><strong>Codex requests permission</strong><p>{request.method}</p></div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          <button
            type="button"
            className="button button--danger approval-action-button"
            title="Reject request"
            aria-label="Reject request"
            onClick={() => onReject(request.id, `Unsupported app-server request: ${request.method}`)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="approval-body">
        <pre className="code-output">{JSON.stringify(request.params, null, 2)}</pre>
        <p className="unsupported-request">This request type is not supported by this client.</p>
      </div>
    </section>
  );
}

function PermissionRequest({ request, onResolve }: RequestCardProps) {
  const reason = readString(request.params.reason);
  return (
    <section className="approval-card" aria-label="Permission approval">
      <div className="approval-card-header">
        <div className="approval-title">
          <ShieldAlert size={17} aria-hidden="true" />
          <div><strong>Grant these permissions?</strong>{reason && <p>{reason}</p>}</div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          <button
            type="button"
            className="button button--primary approval-action-button"
            title="Accept"
            aria-label="Accept"
            onClick={() => onResolve(request.id, { decision: "accept" })}
          >
            <Check size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button button--danger approval-action-button"
            title="Decline"
            aria-label="Decline"
            onClick={() => onResolve(request.id, { decision: "decline" })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="approval-body">
        <div className="approval-context">
          <span>Requested permissions</span>
          <pre>{JSON.stringify(request.params.permissions ?? {}, null, 2)}</pre>
        </div>
      </div>
    </section>
  );
}

interface McpOption {
  value: string;
  label: string;
}

interface McpFormField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  title: string;
  description?: string;
  required: boolean;
  defaultValue: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  options?: McpOption[];
}

function mcpOptions(schema: Record<string, unknown>): McpOption[] | undefined {
  if (Array.isArray(schema.oneOf)) {
    const options = schema.oneOf.flatMap((entry) => (
      isRecord(entry) && typeof entry.const === "string" && typeof entry.title === "string"
        ? [{ value: entry.const, label: entry.title }]
        : []
    ));
    return options.length === schema.oneOf.length ? options : undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.every((entry) => typeof entry === "string")) {
    const names = Array.isArray(schema.enumNames) &&
      schema.enumNames.length === schema.enum.length &&
      schema.enumNames.every((entry) => typeof entry === "string")
      ? schema.enumNames as string[]
      : schema.enum as string[];
    return (schema.enum as string[]).map((value, index) => ({ value, label: names[index] }));
  }
  if (schema.type === "array" && isRecord(schema.items)) {
    if (Array.isArray(schema.items.anyOf)) {
      const options = schema.items.anyOf.flatMap((entry) => (
        isRecord(entry) && typeof entry.const === "string" && typeof entry.title === "string"
          ? [{ value: entry.const, label: entry.title }]
          : []
      ));
      return options.length === schema.items.anyOf.length ? options : undefined;
    }
    if (
      schema.items.type === "string" &&
      Array.isArray(schema.items.enum) &&
      schema.items.enum.every((entry) => typeof entry === "string")
    ) {
      return (schema.items.enum as string[]).map((value) => ({ value, label: value }));
    }
  }
  return undefined;
}

function mcpFormFields(params: Record<string, unknown>): McpFormField[] | null {
  if (params.mode !== "form" || !isRecord(params.requestedSchema)) return null;
  const schema = params.requestedSchema;
  if (schema.type !== "object" || !isRecord(schema.properties)) return null;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const fields: McpFormField[] = [];
  for (const [name, rawField] of Object.entries(schema.properties)) {
    if (
      !isRecord(rawField) ||
      !["string", "number", "integer", "boolean", "array"].includes(String(rawField.type))
    ) {
      return null;
    }
    const type = rawField.type as McpFormField["type"];
    const options = mcpOptions(rawField);
    if (type === "array" && !options) return null;
    const defaultValue = rawField.default ?? (
      type === "boolean" ? false : type === "array" ? [] : ""
    );
    fields.push({
      name,
      type,
      title: readString(rawField.title) ?? name,
      description: readString(rawField.description),
      required: required.has(name),
      defaultValue,
      minimum: typeof rawField.minimum === "number" ? rawField.minimum : undefined,
      maximum: typeof rawField.maximum === "number" ? rawField.maximum : undefined,
      minLength: typeof rawField.minLength === "number" ? rawField.minLength : undefined,
      maxLength: typeof rawField.maxLength === "number" ? rawField.maxLength : undefined,
      minItems: typeof rawField.minItems === "number" ? rawField.minItems : undefined,
      maxItems: typeof rawField.maxItems === "number" ? rawField.maxItems : undefined,
      format: readString(rawField.format),
      options,
    });
  }
  return fields;
}

function mcpFieldComplete(field: McpFormField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number" || field.type === "integer") {
    if (value === "" || value === undefined) return !field.required;
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) &&
      (field.type !== "integer" || Number.isInteger(number)) &&
      (field.minimum === undefined || number >= field.minimum) &&
      (field.maximum === undefined || number <= field.maximum);
  }
  if (field.type === "array") {
    const options = new Set((field.options ?? []).map((option) => option.value));
    return Array.isArray(value) &&
      value.every((entry) => typeof entry === "string" && options.has(entry)) &&
      new Set(value).size === value.length &&
      (field.minItems === undefined || value.length >= field.minItems) &&
      (field.maxItems === undefined || value.length <= field.maxItems);
  }
  if (typeof value !== "string") return false;
  if (!field.required && value === "") return true;
  return (field.minLength === undefined || value.length >= field.minLength) &&
    (field.maxLength === undefined || value.length <= field.maxLength) &&
    (!field.options || field.options.some((option) => option.value === value));
}

function McpFormRequest({ request, onResolve, fields }: RequestCardProps & { fields: McpFormField[] }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(
    fields.map((field) => [field.name, field.defaultValue]),
  ));
  const complete = fields.every((field) => mcpFieldComplete(field, values[field.name]));
  const submit = () => {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.name];
      if ((value === "" || value === undefined) && !field.required) continue;
      content[field.name] = field.type === "number" || field.type === "integer"
        ? Number(value)
        : value;
    }
    onResolve(request.id, { action: "accept", content, _meta: null });
  };
  const message = readString(request.params.message);
  const serverName = readString(request.params.serverName);

  return (
    <section className="approval-card" aria-label="MCP elicitation form">
      <div className="approval-card-header">
        <div className="approval-title">
          <HelpCircle size={17} aria-hidden="true" />
          <div><strong>{serverName ? `${serverName} requests input` : "MCP server requests input"}</strong>{message && <p>{message}</p>}</div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          <button
            type="button"
            className="button button--primary approval-action-button"
            title="Submit and accept"
            aria-label="Submit and accept"
            disabled={!complete}
            onClick={submit}
          >
            <Check size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button button--danger approval-action-button"
            title="Decline"
            aria-label="Decline"
            onClick={() => onResolve(request.id, { action: "decline", content: null, _meta: null })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="approval-body">
        {fields.map((field) => (
          <fieldset key={field.name} className="question-field">
            <legend>{field.title}{field.required ? " *" : ""}</legend>
            {field.description && <p className="approval-field-description">{field.description}</p>}
            {field.type === "boolean" ? (
              <label className="question-option">
                <input
                  type="checkbox"
                  checked={values[field.name] === true}
                  onChange={(event) => setValues((current) => ({
                    ...current,
                    [field.name]: event.target.checked,
                  }))}
                />
                <span><strong>{field.title}</strong></span>
              </label>
            ) : field.type === "array" && field.options ? (
              <div className="question-options">
                {field.options.map((option) => {
                  const selected = Array.isArray(values[field.name])
                    ? values[field.name] as string[]
                    : [];
                  return (
                    <label key={option.value} className="question-option">
                      <input
                        type="checkbox"
                        checked={selected.includes(option.value)}
                        onChange={(event) => setValues((current) => ({
                          ...current,
                          [field.name]: event.target.checked
                            ? [...selected, option.value]
                            : selected.filter((value) => value !== option.value),
                        }))}
                      />
                      <span><strong>{option.label}</strong></span>
                    </label>
                  );
                })}
              </div>
            ) : field.options ? (
              <select
                className="text-input"
                aria-label={field.title}
                value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              >
                <option value="">Select</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                className="text-input"
                aria-label={field.title}
                type={field.type === "number" || field.type === "integer"
                  ? "number"
                  : field.format === "email" ? "email" : field.format === "date" ? "date" : "text"}
                step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined}
                min={field.minimum}
                max={field.maximum}
                minLength={field.minLength}
                maxLength={field.maxLength}
                value={typeof values[field.name] === "string" || typeof values[field.name] === "number"
                  ? values[field.name] as string | number
                  : ""}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              />
            )}
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function McpUrlRequest({ request, onResolve }: RequestCardProps) {
  const message = readString(request.params.message);
  const serverName = readString(request.params.serverName);
  const url = readString(request.params.url);
  return (
    <section className="approval-card" aria-label="MCP URL elicitation">
      <div className="approval-card-header">
        <div className="approval-title">
          <ExternalLink size={17} aria-hidden="true" />
          <div><strong>{serverName ? `${serverName} requests confirmation` : "MCP server requests confirmation"}</strong>{message && <p>{message}</p>}</div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          <button
            type="button"
            className="button button--primary approval-action-button"
            title="Accept"
            aria-label="Accept"
            onClick={() => onResolve(request.id, { action: "accept", content: null, _meta: null })}
          >
            <Check size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button button--danger approval-action-button"
            title="Decline"
            aria-label="Decline"
            onClick={() => onResolve(request.id, { action: "decline", content: null, _meta: null })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {url && (
        <div className="approval-body">
          <a className="approval-external-link" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />Open request
          </a>
          <p className="approval-path"><code>{url}</code></p>
        </div>
      )}
    </section>
  );
}

function UnsupportedMcpRequest({ request, onResolve }: RequestCardProps) {
  return (
    <section className="approval-card" aria-label="Unsupported MCP elicitation">
      <div className="approval-card-header">
        <div className="approval-title">
          <ShieldAlert size={17} aria-hidden="true" />
          <div><strong>MCP request needs an unsupported form</strong><p>{readString(request.params.message)}</p></div>
        </div>
        <div className="approval-actions approval-actions--compact" role="group" aria-label="Approval actions">
          <button
            type="button"
            className="button button--danger approval-action-button"
            title="Decline"
            aria-label="Decline"
            onClick={() => onResolve(request.id, { action: "decline", content: null, _meta: null })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="approval-body">
        <p className="unsupported-request">Ask Codex cannot safely validate this MCP form mode.</p>
      </div>
    </section>
  );
}

function McpElicitationRequest(props: RequestCardProps) {
  if (props.request.params.mode === "url") return <McpUrlRequest {...props} />;
  const fields = mcpFormFields(props.request.params);
  return fields
    ? <McpFormRequest {...props} fields={fields} />
    : <UnsupportedMcpRequest {...props} />;
}

const COMMAND_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "execCommandApproval",
]);
const FILE_APPROVAL_METHODS = new Set([
  "item/fileChange/requestApproval",
  "applyPatchApproval",
]);

export function ApprovalPanel({ requests, onResolve, onReject }: ApprovalPanelProps) {
  if (requests.length === 0) return null;
  return (
    <aside className="approval-panel" aria-live="polite">
      {requests.map((request) => {
        if (request.method === "item/tool/requestUserInput") {
          return <QuestionRequest key={request.id} request={request} onResolve={onResolve} />;
        }
        if (COMMAND_APPROVAL_METHODS.has(request.method) || FILE_APPROVAL_METHODS.has(request.method)) {
          return (
            <ApprovalRequest
              key={request.id}
              request={request}
              onResolve={onResolve}
              onReject={onReject}
            />
          );
        }
        if (request.method === "item/permissions/requestApproval") {
          return <PermissionRequest key={request.id} request={request} onResolve={onResolve} />;
        }
        if (request.method === "mcpServer/elicitation/request") {
          return <McpElicitationRequest key={request.id} request={request} onResolve={onResolve} />;
        }
        return <GenericRequest key={request.id} request={request} onResolve={onResolve} onReject={onReject} />;
      })}
    </aside>
  );
}
