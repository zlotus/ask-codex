import { Check, CheckCheck, FileCode2, HelpCircle, ShieldAlert, Terminal, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PendingRequest } from "../types/protocol";
import { commandText, parseQuestions, readString } from "../utils/protocol";

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

function FailClosedRequest({ request, onResolve }: RequestCardProps) {
  const result = request.method === "item/permissions/requestApproval"
    ? { permissions: {}, scope: "turn" }
    : { action: "decline", content: null, _meta: null };
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
            title="Decline"
            aria-label="Decline"
            onClick={() => onResolve(request.id, result)}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="approval-body">
        <pre className="code-output">{JSON.stringify(request.params, null, 2)}</pre>
      </div>
    </section>
  );
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
        if (
          request.method === "item/permissions/requestApproval" ||
          request.method === "mcpServer/elicitation/request"
        ) {
          return <FailClosedRequest key={request.id} request={request} onResolve={onResolve} />;
        }
        return <GenericRequest key={request.id} request={request} onResolve={onResolve} onReject={onReject} />;
      })}
    </aside>
  );
}
