"""Pure request routing and clarification primitives for CodePilot.

The module deliberately has no network, filesystem, or model dependencies.  It
is the small policy layer that runs before the coding-agent loop: greetings can
be answered locally, precise low-risk requests can go straight to execution,
and vague or risky requests are turned into bounded clarification questions or
an approval-backed plan.

The heuristics are intentionally explainable rather than pretending to be a
classifier with calibrated probabilities.  ``confidence`` and ``ambiguity``
are bounded scores useful for UI decisions and telemetry only.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence


# The elicitation loop is model-driven: the model decides when it has enough
# information, so this cap is only a safety floor against a model that keeps
# inventing new questions forever.  Each round may carry up to MAX_QUESTIONS.
MAX_CLARIFICATION_ROUNDS = 8
MAX_QUESTIONS = 10
MAX_TEXT_CHARS = 12_000
MAX_ASSUMPTIONS = 12


def _bounded(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    if number != number:  # NaN
        number = default
    return max(0.0, min(1.0, number))


def _text(value: Any, limit: int = MAX_TEXT_CHARS) -> str:
    value = "" if value is None else str(value)
    return value.strip()[:limit]


def _normalise(value: Any) -> str:
    return unicodedata.normalize("NFKC", _text(value)).casefold()


@dataclass
class Question:
    """One user-facing clarification question.

    ``id`` is stable within a clarification state and is used to associate a
    later answer with the question.  ``required`` distinguishes facts that
    must be supplied before a plan can be approved from optional preferences.
    """

    id: str
    text: str
    required: bool = True
    choices: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", _text(self.id, 80)).strip("-") or "question"
        self.text = _text(self.text, 500)
        self.required = bool(self.required)
        self.choices = [_text(item, 120) for item in list(self.choices or [])[:8] if _text(item, 120)]

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {"id": self.id, "text": self.text, "required": self.required}
        if self.choices:
            result["choices"] = list(self.choices)
        return result

    @classmethod
    def from_dict(cls, value: Any) -> "Question":
        if isinstance(value, Question):
            return value
        if not isinstance(value, Mapping):
            raise ValueError("question must be an object")
        question_id = _text(value.get("id"), 80)
        question_text = _text(value.get("text") or value.get("question"), 500)
        if not question_id or not question_text:
            raise ValueError("question id and text are required")
        choices = value.get("choices") if isinstance(value.get("choices"), list) else []
        return cls(question_id, question_text, bool(value.get("required", True)), choices)


@dataclass
class RouteDecision:
    """Explainable result of local request routing."""

    route: str
    requires_model: bool
    requires_approval: bool = False
    high_risk: bool = False
    ambiguity: float = 0.0
    confidence: float = 0.0
    complexity: str = "low"
    reasons: List[str] = field(default_factory=list)
    delegated: bool = False
    read_only: bool = False

    def __post_init__(self) -> None:
        allowed_routes = {"local_chat", "direct_execute", "clarify", "plan"}
        if self.route not in allowed_routes:
            raise ValueError("unknown route: %s" % self.route)
        self.requires_model = bool(self.requires_model)
        self.requires_approval = bool(self.requires_approval)
        self.high_risk = bool(self.high_risk)
        self.delegated = bool(self.delegated)
        self.read_only = bool(self.read_only)
        self.ambiguity = _bounded(self.ambiguity)
        self.confidence = _bounded(self.confidence)
        if self.complexity not in {"low", "medium", "high"}:
            self.complexity = "medium"
        self.reasons = [_text(reason, 240) for reason in list(self.reasons or [])[:12] if _text(reason, 240)]

    @property
    def kind(self) -> str:
        return self.route

    def to_dict(self) -> Dict[str, Any]:
        return {
            "route": self.route,
            "kind": self.route,
            "requires_model": self.requires_model,
            "requires_approval": self.requires_approval,
            "high_risk": self.high_risk,
            "ambiguity": self.ambiguity,
            "confidence": self.confidence,
            "complexity": self.complexity,
            "reasons": list(self.reasons),
            "delegated": self.delegated,
            "read_only": self.read_only,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "RouteDecision":
        route = _text(value.get("route") or value.get("kind"), 40)
        if route == "ready_for_plan":
            route = "plan"
        if route == "needs_clarification":
            route = "clarify"
        return cls(
            route=route,
            requires_model=bool(value.get("requires_model", route != "local_chat")),
            requires_approval=bool(value.get("requires_approval", route == "plan")),
            high_risk=bool(value.get("high_risk", False)),
            ambiguity=_bounded(value.get("ambiguity")),
            confidence=_bounded(value.get("confidence")),
            complexity=_text(value.get("complexity") or "medium", 20),
            reasons=list(value.get("reasons") or []),
            delegated=bool(value.get("delegated", False)),
            read_only=bool(value.get("read_only", False)),
        )


@dataclass
class IntakeResult:
    """Validated structured output from an optional intake model call."""

    route: str
    confidence: float
    questions: List[Question] = field(default_factory=list)
    assumptions: List[str] = field(default_factory=list)
    ready: bool = False
    delegated: bool = False
    high_risk: bool = False
    ambiguity: float = 0.0
    complexity: str = "medium"
    reasons: List[str] = field(default_factory=list)
    # Natural-language analysis the model wrote before its structured JSON.
    # Streamed to the UI as it is generated and kept in the conversation so
    # later elicitation rounds see the agent's own reasoning.
    narrative: str = ""

    def __post_init__(self) -> None:
        if self.route not in {"clarify", "plan", "direct_execute", "local_chat"}:
            raise ValueError("invalid intake route")
        self.confidence = _bounded(self.confidence)
        self.ambiguity = _bounded(self.ambiguity)
        self.questions = list(self.questions or [])[:MAX_QUESTIONS]
        self.assumptions = [_text(item, 500) for item in list(self.assumptions or [])[:MAX_ASSUMPTIONS] if _text(item, 500)]
        self.ready = bool(self.ready)
        self.delegated = bool(self.delegated)
        self.high_risk = bool(self.high_risk)
        if self.complexity not in {"low", "medium", "high"}:
            self.complexity = "medium"
        self.reasons = [_text(item, 240) for item in list(self.reasons or [])[:12] if _text(item, 240)]

    @property
    def kind(self) -> str:
        return "needs_clarification" if self.route == "clarify" and not self.ready else ("ready_for_plan" if self.route == "plan" else self.route)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "route": self.route,
            "kind": self.kind,
            "confidence": self.confidence,
            "questions": [question.to_dict() for question in self.questions],
            "assumptions": list(self.assumptions),
            "ready": self.ready,
            "delegated": self.delegated,
            "high_risk": self.high_risk,
            "ambiguity": self.ambiguity,
            "complexity": self.complexity,
            "reasons": list(self.reasons),
            "narrative": self.narrative,
        }


@dataclass
class ClarificationState:
    """Bounded, serialisable state for a multi-turn clarification phase."""

    questions: List[Question] = field(default_factory=list)
    answers: Dict[str, str] = field(default_factory=dict)
    assumptions: List[str] = field(default_factory=list)
    round: int = 0
    max_rounds: int = MAX_CLARIFICATION_ROUNDS
    model_calls: int = 0
    last_question_fingerprint: str = ""
    # Completed clarification batches, newest last.  Each entry keeps the
    # questions the user actually answered plus their answers, so the UI can
    # still show round 1 / round 2 ... as a distinct read-only history while a
    # new round is being asked.
    rounds: List[Dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        # Keep one question per id and enforce hard bounds even when loading a
        # hand-edited/corrupt session snapshot.
        unique: List[Question] = []
        seen = set()
        for item in list(self.questions or []):
            try:
                question = Question.from_dict(item)
            except ValueError:
                continue
            if question.id in seen:
                continue
            seen.add(question.id)
            unique.append(question)
            if len(unique) >= MAX_QUESTIONS:
                break
        self.questions = unique
        self.answers = {
            _text(key, 80): _text(value, 2_000)
            for key, value in dict(self.answers or {}).items()
            if _text(key, 80) and _text(value, 2_000)
        }
        self.assumptions = [_text(item, 500) for item in list(self.assumptions or [])[:MAX_ASSUMPTIONS] if _text(item, 500)]
        try:
            self.round = max(0, min(int(self.round), MAX_CLARIFICATION_ROUNDS))
        except (TypeError, ValueError):
            self.round = 0
        try:
            self.max_rounds = max(1, min(int(self.max_rounds), MAX_CLARIFICATION_ROUNDS))
        except (TypeError, ValueError):
            self.max_rounds = MAX_CLARIFICATION_ROUNDS
        try:
            self.model_calls = max(0, min(int(self.model_calls), MAX_CLARIFICATION_ROUNDS))
        except (TypeError, ValueError):
            self.model_calls = 0
        self.last_question_fingerprint = _text(self.last_question_fingerprint, 128)
        # Normalise the persisted round history: only keep batches that carry
        # at least one answered question, bounded like everything else here.
        cleaned: List[Dict[str, Any]] = []
        for entry in list(self.rounds or [])[:MAX_CLARIFICATION_ROUNDS]:
            if not isinstance(entry, dict):
                continue
            questions: List[Dict[str, Any]] = []
            for item in list(entry.get("questions") or [])[:MAX_QUESTIONS]:
                try:
                    question = Question.from_dict(item)
                except ValueError:
                    continue
                if question.id and question.text:
                    questions.append(question.to_dict())
            answers = {
                _text(key, 80): _text(value, 2_000)
                for key, value in dict(entry.get("answers") or {}).items()
                if _text(key, 80) and _text(value, 2_000)
            }
            if questions and answers:
                cleaned.append({"round": max(0, int(entry.get("round") or 0)), "questions": questions, "answers": answers})
        self.rounds = cleaned

    @property
    def required_questions(self) -> List[Question]:
        return [question for question in self.questions if question.required]

    @property
    def unresolved_questions(self) -> List[Question]:
        return [question for question in self.required_questions if not self.answers.get(question.id, "").strip()]

    @property
    def ready(self) -> bool:
        return not self.unresolved_questions

    def record_answer(self, question_id: str, answer: str) -> None:
        question_id = _text(question_id, 80)
        answer = _text(answer, 2_000)
        if not question_id:
            raise ValueError("question id is required")
        if not answer:
            raise ValueError("answer is required")
        if self.questions and question_id not in {question.id for question in self.questions}:
            raise KeyError(question_id)
        self.answers[question_id] = answer

    def apply_answers(self, answers: Mapping[str, Any]) -> int:
        changed = 0
        for question_id, answer in dict(answers or {}).items():
            value = _text(answer, 2_000)
            if not value:
                continue
            normalized_id = _text(question_id, 80)
            # A browser may keep a stale answer field after a re-plan.  Ignore
            # that one field while still applying the other valid answers in
            # the same request; a single stale key must not discard the whole
            # clarification turn.
            if self.questions and normalized_id not in {question.id for question in self.questions}:
                continue
            before = self.answers.get(normalized_id)
            self.record_answer(normalized_id, value)
            if before != value:
                changed += 1
        return changed

    def question_fingerprint(self, questions: Optional[Sequence[Question]] = None) -> str:
        selected = questions if questions is not None else self.questions
        payload = "\n".join("%s:%s:%s" % (question.id, question.text, int(question.required)) for question in selected)
        return sha256(payload.encode("utf-8")).hexdigest()[:24]

    def repeated_questions(self, questions: Optional[Sequence[Question]] = None) -> bool:
        fingerprint = self.question_fingerprint(questions)
        return bool(fingerprint and fingerprint == self.last_question_fingerprint)

    def remember_questions(self, questions: Sequence[Question]) -> None:
        # A new batch is arriving, so the previous batch (if the user answered
        # anything in it) becomes part of the read-only round history.
        answered_previous = {question.id: self.answers[question.id] for question in self.questions if self.answers.get(question.id, "").strip()}
        if answered_previous:
            self.rounds.append({
                "round": self.round,
                "questions": [question.to_dict() for question in self.questions if question.id in answered_previous],
                "answers": answered_previous,
            })
            self.rounds = self.rounds[-MAX_CLARIFICATION_ROUNDS:]
        merged: List[Question] = []
        previous = list(self.questions)
        for item in list(questions)[:MAX_QUESTIONS]:
            question = Question.from_dict(item) if not isinstance(item, Question) else item
            # Models regenerate question ids every round.  Reuse the previous
            # id when the same question text is asked again so already
            # recorded answers stay associated instead of the round re-asking
            # the very question the user just answered.
            for index, prev in enumerate(previous):
                if prev.text == question.text:
                    question.id = prev.id
                    previous.pop(index)
                    break
            merged.append(question)
        self.questions = merged
        self.last_question_fingerprint = self.question_fingerprint(self.questions)

    def can_ask_more(self, round_number: Optional[int] = None) -> bool:
        current = self.round if round_number is None else int(round_number)
        return current < min(self.max_rounds, MAX_CLARIFICATION_ROUNDS)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "questions": [question.to_dict() for question in self.questions],
            "answers": dict(self.answers),
            "assumptions": list(self.assumptions),
            "round": self.round,
            "max_rounds": self.max_rounds,
            "model_calls": self.model_calls,
            "last_question_fingerprint": self.last_question_fingerprint,
            "rounds": list(self.rounds),
            "ready": self.ready,
        }

    @classmethod
    def from_dict(cls, value: Any) -> "ClarificationState":
        if not isinstance(value, Mapping):
            return cls()
        return cls(
            questions=[Question.from_dict(item) for item in list(value.get("questions") or [])[:MAX_QUESTIONS]],
            answers=dict(value.get("answers") or {}),
            assumptions=list(value.get("assumptions") or []),
            round=value.get("round", 0),
            max_rounds=value.get("max_rounds", MAX_CLARIFICATION_ROUNDS),
            model_calls=value.get("model_calls", 0),
            last_question_fingerprint=value.get("last_question_fingerprint", ""),
            rounds=list(value.get("rounds") or []),
        )


_GREETING_RE = re.compile(
    r"^(?:hi|hello|hey|你好(?:呀|啊|喽)?|您好|嗨|哈喽|早上好|下午好|晚上好|谢谢|感谢|再见|拜拜|你是谁|你能做什么)[!！,，。.?？\s~～]*$",
    re.IGNORECASE,
)
_CODING_MARKERS = (
    "修复", "实现", "添加", "增加", "删除", "重构", "优化", "测试", "代码", "文件", "项目", "接口", "功能",
    "fix", "implement", "add", "remove", "delete", "refactor", "optimize", "test", "code", "file", "bug", "feature",
)
_RISK_MARKERS = (
    "删除", "清空", "迁移", "生产", "数据库", "凭据", "密码", "密钥", "部署", "发布", "权限", "支付", "不可逆",
    "drop", "truncate", "delete", "production", "database", "credential", "secret", "deploy", "migration", "payment",
)
_READ_ONLY_MARKERS = ("解释", "说明", "怎么工作", "如何工作", "what is", "explain", "describe", "how does", "inspect", "list", "check")
_MUTATION_MARKERS = (
    "修复", "实现", "添加", "增加", "删除", "重构", "优化", "修改", "改写", "更新", "新建", "迁移", "实现",
    "fix", "implement", "add", "remove", "delete", "refactor", "optimize", "update", "rewrite", "create", "write", "migrate",
)
_DELEGATION_MARKERS = ("都行", "随便", "你决定", "你看着办", "按最佳实践", "你来选", "any", "you decide", "best practice")
_PRECISION_MARKERS = ("运行", "执行", "指定", "中", "中的", "函数", "方法", "line", "run", "command", "exactly")


def _contains_marker(text: str, markers: Iterable[str]) -> bool:
    return any(marker in text for marker in markers)


def _looks_like_path(text: str) -> bool:
    return bool(re.search(r"(?:[./\\][\w.-]+|\b[\w.-]+\.(?:py|js|ts|tsx|jsx|java|go|rs|md|json|yaml|yml|toml|sql|cs)\b)", text, re.IGNORECASE))


def _is_greeting(text: str) -> bool:
    compact = re.sub(r"[\s]+", "", text)
    return bool(compact and _GREETING_RE.fullmatch(compact))


def _complexity(text: str, marker_count: int) -> str:
    length_score = min(3, len(text) // 180)
    conjunctions = len(re.findall(r"(?:然后|并且|同时|以及|and|then|also|;|；)", text))
    score = marker_count + length_score + min(3, conjunctions)
    if score >= 7 or len(text) > 700:
        return "high"
    if score >= 3 or len(text) > 240:
        return "medium"
    return "low"


def classify_request(text: str, requested_mode: str = "execute") -> RouteDecision:
    """Classify a request without side effects or model calls.

    The order is important: a pure greeting is handled locally, while a
    greeting containing a coding marker (``Hi, fix login.py``) is a coding
    request.  Dangerous requests never become ``direct_execute`` even when the
    user asks the agent to choose the details.
    """

    original = _text(text)
    normalized = _normalise(original)
    mode = _normalise(requested_mode) or "execute"
    if mode not in {"plan", "execute"}:
        mode = "execute"
    if not original:
        return RouteDecision("clarify", True, True, False, 1.0, 0.0, "low", ["empty task"], False)

    coding = _contains_marker(normalized, _CODING_MARKERS) or _looks_like_path(normalized) or "```" in original or bool(re.search(r"\b(?:pytest|unittest|npm|cargo|go test|dotnet test)\b", normalized))
    if _is_greeting(normalized) and not coding:
        return RouteDecision("local_chat", False, False, False, 0.0, 0.99, "low", ["greeting or capability question"], False)

    read_only = _contains_marker(normalized, _READ_ONLY_MARKERS) and not _contains_marker(normalized, _MUTATION_MARKERS)
    risk = _contains_marker(normalized, _RISK_MARKERS)
    delegated = _contains_marker(normalized, _DELEGATION_MARKERS)
    has_target = _looks_like_path(normalized) or bool(re.search(r"(?:模块|组件|函数|方法|接口|表|数据|登录|login|feature|function|module|component)", normalized, re.IGNORECASE))
    has_acceptance = bool(re.search(r"(?:测试|验证|验收|通过|运行|命令|test|verify|check|run|assert|expected)", normalized, re.IGNORECASE))
    explicit_action = _contains_marker(normalized, _CODING_MARKERS)
    precision = has_target and (has_acceptance or _contains_marker(normalized, _PRECISION_MARKERS))

    ambiguity = 0.12
    reasons: List[str] = []
    if not has_target:
        ambiguity += 0.36
        reasons.append("missing a concrete target")
    if not has_acceptance and explicit_action:
        ambiguity += 0.18
        reasons.append("missing an acceptance or verification criterion")
    # Feature-level requests (login, dashboard, authentication, etc.) name a
    # domain but not an implementable behavior.  Treat them as underspecified
    # even when the domain token itself counts as a nominal target.
    if explicit_action and not _looks_like_path(normalized) and not has_acceptance and re.search(
        r"(?:登录|认证|权限|仪表盘|dashboard|login|auth|feature|功能)", normalized, re.IGNORECASE
    ):
        ambiguity += 0.30
        reasons.append("feature request lacks concrete behavior or scope")
    if len(original) < 12:
        ambiguity += 0.12
    if "整个项目" in normalized or "everything" in normalized or "高级" in normalized or "更好看" in normalized:
        ambiguity += 0.24
        reasons.append("scope or preference is open-ended")
    # Product-sized experience requests need scope confirmation before tools.
    if re.search(r"(?:娓告垙|game|system|dashboard|responsive|random|multiple|complete|沉浸|响应式|随机|多个|完整)", normalized, re.IGNORECASE):
        ambiguity += 0.34
        reasons.append("product experience request needs scope confirmation")
    if risk:
        reasons.append("request contains a high-risk operation")
    if delegated:
        reasons.append("user delegated optional choices")
    ambiguity = _bounded(ambiguity)

    marker_count = sum(1 for marker in _CODING_MARKERS if marker in normalized)
    complexity = _complexity(original, marker_count)
    high_risk = risk
    confidence = _bounded(0.58 + (0.22 if precision else 0.0) - (0.22 if ambiguity >= 0.55 else 0.0) - (0.08 if high_risk else 0.0))

    if read_only:
        return RouteDecision("direct_execute", True, False, False, ambiguity, confidence, complexity, reasons + ["read-only explanation"], delegated, True)

    # Explicit Plan is authoritative for clear requests.  It may still enter
    # clarification if essential facts are missing, but never silently drops to
    # direct execution.
    # Creative/product-sized requests contain important preference decisions
    # that cannot be safely inferred (for example which mini-games, visual
    # tone, persistence and scoring rules). Always ask first, even when the
    # user explicitly selected Plan mode.
    product_experience = bool(re.search(r"(?:game|游戏|system|系统|responsive|响应式|random|随机|沉浸|multiple|多个|完整|上岸)", normalized, re.IGNORECASE))
    if mode == "plan":
        # Explicit Plan is authoritative.  Only genuinely underspecified
        # requests (rather than a short feature label such as "add a
        # feature") pause for intake; everything else gets a visible draft
        # plan and remains approval-gated.
        route = "clarify" if (product_experience or ambiguity >= 0.70) and not (delegated and not high_risk) else "plan"
        return RouteDecision(route, True, True, high_risk, ambiguity, confidence, complexity, reasons, delegated)

    if high_risk:
        # A dangerous but underspecified task needs facts first; a concrete one
        # can be represented as an approval-backed plan immediately.
        route = "clarify" if ambiguity >= 0.55 and not precision else "plan"
        return RouteDecision(route, True, True, True, ambiguity, confidence, complexity, reasons, delegated)
    if ambiguity >= 0.55 or complexity == "high":
        return RouteDecision("clarify", True, False, False, ambiguity, confidence, complexity, reasons, delegated)
    # Every coding change is approval-gated behind a visible Plan. Execute
    # mode controls the user's preferred workspace view, not a bypass around
    # planning. Pure explanations and local chat returned above remain direct.
    if precision or explicit_action:
        return RouteDecision("plan", True, True, False, ambiguity, confidence, complexity, reasons + ["coding work requires a plan before execution"], delegated, read_only)
    return RouteDecision("plan", True, True, False, ambiguity, confidence, complexity, reasons + ["project work requires a plan before execution"], delegated, read_only)


def clarification_questions(task: str, decision: Optional[RouteDecision] = None) -> List[Question]:
    """Create only the questions justified by the task, capped at ten."""

    decision = decision or classify_request(task, requested_mode="execute")
    normalized = _normalise(task)
    questions: List[Question] = []
    if not (_looks_like_path(normalized) or re.search(r"(?:模块|组件|函数|接口|表|数据)", normalized)):
        questions.append(Question("target", "要修改哪个文件、模块或页面？请给出相对路径或明确范围。", True))
    if any(token in normalized for token in ("登录", "login", "权限", "认证", "auth")):
        questions.append(Question("behavior", "登录/认证需要支持哪些行为（例如用户来源、会话方式和失败提示）？", True))
    elif decision.high_risk or any(token in normalized for token in ("迁移", "数据库", "支付", "生产", "delete", "drop")):
        questions.append(Question("safety_scope", "请确认目标环境、影响范围和可回滚方案；哪些数据或接口绝不能改变？", True))
    elif not any(token in normalized for token in ("测试", "验证", "验收", "test", "check", "run")):
        questions.append(Question("acceptance", "完成的验收标准是什么？需要运行哪条测试或 smoke 命令？", True))
    if re.search(r"(?:game|游戏|system|系统|responsive|响应式|random|随机|沉浸|多个|multiple|上岸)", normalized, re.IGNORECASE):
        questions.extend([
            Question("game_preferences", "你最想优先保留或新增哪些小游戏？每个游戏希望偏策略、反应、记忆还是知识问答？", True),
            Question("visual_style", "页面更偏好哪种沉浸风格（例如南大紫学术风、赛博闯关、轻松校园风）？是否有必须保留的配色？（提示：南大主色为南大紫，约 #63065F / #5a0B57，不要采用红白或蓝白作为主色）", False),
            Question("result_rules", "积分、随机事件和最终结论希望如何组合？是否需要保存历史成绩、支持重新挑战？", False),
        ])
    elif decision.complexity in {"medium", "high"} or decision.ambiguity >= 0.7:
        questions.append(Question("constraints", "有哪些技术约束或必须保留的现有行为（API、依赖、样式或兼容性）？", False))
    if decision.delegated and not decision.high_risk:
        # Delegation is represented as an assumption rather than another
        # question; this is what lets “按最佳实践即可” terminate cleanly.
        return questions[:MAX_QUESTIONS]
    return questions[:MAX_QUESTIONS]


def extract_first_json_object(text: str) -> Optional[str]:
    """Return the first complete JSON object in ``text``, if any.

    Intake prompts ask for JSON-only answers, but some gateways keep the HTTP
    stream open after a valid object (or append trailing prose).  Early-stop
    and tolerant parsing both need a balanced-object extractor that respects
    string escapes.
    """
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.DOTALL).strip()
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(raw)):
        char = raw[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                candidate = raw[start : index + 1]
                try:
                    json.loads(candidate)
                except json.JSONDecodeError:
                    return None
                return candidate
    return None


def parse_intake_response(value: Any) -> IntakeResult:
    """Validate a structured intake response from a model or test fixture."""

    candidate = value
    if hasattr(candidate, "content") and not isinstance(candidate, (dict, list, str)):
        candidate = getattr(candidate, "content", "")
    if isinstance(candidate, str):
        raw = candidate.strip()
        extracted = extract_first_json_object(raw)
        if extracted is None:
            raise ValueError("intake response must be valid JSON")
        try:
            candidate = json.loads(extracted)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("intake response must be valid JSON") from exc
    if not isinstance(candidate, Mapping):
        raise ValueError("intake response must be an object")
    kind = _normalise(candidate.get("kind") or candidate.get("route"))
    aliases = {
        "needs_clarification": "clarify",
        "needs-clarification": "clarify",
        "ready_for_plan": "plan",
        "ready-for-plan": "plan",
        "direct": "direct_execute",
        "direct_execute": "direct_execute",
        "local_chat": "local_chat",
        "clarify": "clarify",
        "plan": "plan",
    }
    route = aliases.get(kind)
    if route is None:
        raise ValueError("invalid intake kind")
    confidence = candidate.get("confidence", 0.0)
    try:
        confidence_number = float(confidence)
    except (TypeError, ValueError) as exc:
        raise ValueError("confidence must be a number") from exc
    if confidence_number < 0.0 or confidence_number > 1.0:
        raise ValueError("confidence must be between 0 and 1")
    raw_questions = candidate.get("questions") or []
    if not isinstance(raw_questions, list) or len(raw_questions) > MAX_QUESTIONS:
        raise ValueError("at most %d questions are allowed" % MAX_QUESTIONS)
    questions = [Question.from_dict(item) for item in raw_questions]
    ids = [question.id for question in questions]
    if len(ids) != len(set(ids)):
        raise ValueError("question ids must be unique")
    assumptions = candidate.get("assumptions") or []
    if not isinstance(assumptions, list) or len(assumptions) > MAX_ASSUMPTIONS:
        raise ValueError("too many assumptions")
    result = IntakeResult(
        route=route,
        confidence=confidence_number,
        questions=questions,
        assumptions=assumptions,
        ready=bool(candidate.get("ready", route != "clarify")),
        delegated=bool(candidate.get("delegated", False)),
        high_risk=bool(candidate.get("high_risk", False)),
        ambiguity=_bounded(candidate.get("ambiguity")),
        complexity=_text(candidate.get("complexity") or "medium", 20),
        reasons=list(candidate.get("reasons") or []),
    )
    if result.route == "clarify" and result.ready and not result.questions:
        # A ready clarification response is equivalent to a plan hand-off.
        result.route = "plan"
    if result.route == "clarify" and not result.ready and not result.questions:
        raise ValueError("clarification response must include a question")
    return result


def local_reply(message: str) -> str:
    """Answer greetings/capability questions without contacting a model."""

    normalized = _normalise(message)
    if any(token in normalized for token in ("你是谁", "你能做什么", "what can you do", "who are you")):
        return "我是 CodePilot：我可以在你打开的工作区中阅读、修改并测试代码；涉及计划或高风险操作时会先请求确认。"
    if any(token in normalized for token in ("谢谢", "感谢", "thank")):
        return "不客气。准备好后告诉我你想完成的编程任务即可。"
    if any(token in normalized for token in ("再见", "拜拜", "bye")):
        return "再见，随时可以继续你的编程任务。"
    return "你好！我是 CodePilot。请告诉我你想在当前工作区完成什么编程任务。"


__all__ = [
    "MAX_CLARIFICATION_ROUNDS",
    "MAX_QUESTIONS",
    "Question",
    "RouteDecision",
    "IntakeResult",
    "ClarificationState",
    "classify_request",
    "clarification_questions",
    "parse_intake_response",
    "extract_first_json_object",
    "local_reply",
]
