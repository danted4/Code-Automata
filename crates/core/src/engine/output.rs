//! What each agent step must answer with.
//!
//! Every type has a JSON Schema (handed to providers with structured output, which then validate
//! it themselves) and a validator (run on every answer, structured or extracted from text).

use std::collections::HashSet;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::agent::Outcome;

/// An answer an agent step must produce.
pub trait AgentOutput: DeserializeOwned + Sized {
    /// The top-level key that identifies this answer in free text.
    const KEY: &'static str;
    fn schema() -> Value;
    /// A short example of the expected JSON, for prompts.
    fn example() -> &'static str;
    fn validate(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOut {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuestionsOut {
    pub questions: Vec<QuestionOut>,
}

impl AgentOutput for QuestionsOut {
    const KEY: &'static str = "questions";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": { "questions": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "text": { "type": "string" },
                    "options": { "type": "array", "items": { "type": "string" } },
                    "required": { "type": "boolean" }
                },
                "required": ["id", "text", "options", "required"]
            } } },
            "required": ["questions"]
        })
    }
    fn example() -> &'static str {
        r#"{"questions":[{"id":"q1","text":"Which database?","options":["Postgres","SQLite"],"required":true}]}"#
    }
    fn validate(&self) -> Result<(), String> {
        if self.questions.is_empty() || self.questions.len() > 20 {
            return Err(format!(
                "give between 1 and 20 questions (got {})",
                self.questions.len()
            ));
        }
        unique_ids(self.questions.iter().map(|q| q.id.as_str()), "question")?;
        for q in &self.questions {
            if q.text.trim().is_empty() {
                return Err(format!("question {:?} has no text", q.id));
            }
            if q.options.len() > 8 {
                return Err(format!("question {:?} has more than 8 options", q.id));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PlanOut {
    pub plan: String,
}

impl AgentOutput for PlanOut {
    const KEY: &'static str = "plan";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": { "plan": { "type": "string", "description": "The plan as markdown" } },
            "required": ["plan"]
        })
    }
    fn example() -> &'static str {
        r##"{"plan":"# Title\n\n## Overview\n...\n\n## Implementation Steps\n1. ...\n2. ..."}"##
    }
    fn validate(&self) -> Result<(), String> {
        let plan = self.plan.trim();
        if plan.len() < 40 {
            return Err("the plan is empty or too short to act on".into());
        }
        if !plan.lines().any(|l| l.trim_start().starts_with('#')) {
            return Err("the plan needs markdown headings".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtaskKindOut {
    Dev,
    Qa,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskOut {
    pub id: String,
    pub kind: SubtaskKindOut,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub progress_label: Option<String>,
    /// In a workspace, the repository folders the subtask changes (guidance only).
    #[serde(default)]
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SubtasksOut {
    pub subtasks: Vec<SubtaskOut>,
}

pub const MAX_SUBTASKS: usize = 25;

impl AgentOutput for SubtasksOut {
    const KEY: &'static str = "subtasks";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": { "subtasks": { "type": "array", "items": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "pattern": "^[A-Za-z0-9_-]+$" },
                    "kind": { "type": "string", "enum": ["dev", "qa"] },
                    "title": { "type": "string" },
                    "detail": { "type": "string" },
                    "progressLabel": { "type": "string" },
                    "repos": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id", "kind", "title", "detail"]
            } } },
            "required": ["subtasks"]
        })
    }
    fn example() -> &'static str {
        r#"{"subtasks":[{"id":"dev-1","kind":"dev","title":"Add endpoint","detail":"Create ... in src/...","progressLabel":"Adding endpoint"},{"id":"qa-1","kind":"qa","title":"Verify endpoint","detail":"Run the tests and check ..."}]}"#
    }
    fn validate(&self) -> Result<(), String> {
        let n = self.subtasks.len();
        if n == 0 || n > MAX_SUBTASKS {
            return Err(format!(
                "give between 1 and {MAX_SUBTASKS} subtasks (got {n})"
            ));
        }
        if !self.subtasks.iter().any(|s| s.kind == SubtaskKindOut::Dev) {
            return Err("include at least one dev subtask".into());
        }
        if !self.subtasks.iter().any(|s| s.kind == SubtaskKindOut::Qa) {
            return Err("include at least one qa subtask that verifies the work".into());
        }
        unique_ids(self.subtasks.iter().map(|s| s.id.as_str()), "subtask")?;
        for s in &self.subtasks {
            if crate::util::validate_task_id(&s.id).is_err() {
                return Err(format!(
                    "subtask id {:?} must use only letters, digits, '-' and '_'",
                    s.id
                ));
            }
            if s.title.trim().is_empty() || s.detail.trim().is_empty() {
                return Err(format!("subtask {:?} needs a title and a detail", s.id));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DevOut {
    pub summary: String,
    #[serde(default)]
    pub handoff: String,
}

impl AgentOutput for DevOut {
    const KEY: &'static str = "summary";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "summary": { "type": "string", "description": "What you changed, in a few lines" },
                "handoff": { "type": "string", "description": "What the next subtasks must know" }
            },
            "required": ["summary", "handoff"]
        })
    }
    fn example() -> &'static str {
        r#"{"summary":"Added the endpoint in src/api.rs and its route.","handoff":"The endpoint returns 404 until the store is wired in the next subtask."}"#
    }
    fn validate(&self) -> Result<(), String> {
        if self.summary.trim().is_empty() {
            return Err("the summary is empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QaOut {
    pub passed: bool,
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<String>,
}

impl AgentOutput for QaOut {
    const KEY: &'static str = "passed";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "passed": { "type": "boolean" },
                "summary": { "type": "string" },
                "findings": { "type": "array", "items": { "type": "string" },
                              "description": "Concrete problems found; empty when passed" }
            },
            "required": ["passed", "summary", "findings"]
        })
    }
    fn example() -> &'static str {
        r#"{"passed":false,"summary":"The endpoint works but pagination is missing.","findings":["GET /items ignores the cursor parameter (src/api.rs:40)"]}"#
    }
    fn validate(&self) -> Result<(), String> {
        if self.summary.trim().is_empty() {
            return Err("the summary is empty".into());
        }
        if !self.passed && self.findings.iter().all(|f| f.trim().is_empty()) {
            return Err("a failing verdict must list at least one finding".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TriageVerdict {
    /// The interrupted subtask's work is complete; checkpoint it and move on.
    Done,
    /// Some of it is done; continue from the changes.
    Partial,
    /// The changes are unusable; discard them and redo the subtask.
    Broken,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TriageOut {
    pub verdict: TriageVerdict,
    pub reason: String,
}

impl AgentOutput for TriageOut {
    const KEY: &'static str = "verdict";
    fn schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "verdict": { "type": "string", "enum": ["done", "partial", "broken"] },
                "reason": { "type": "string" }
            },
            "required": ["verdict", "reason"]
        })
    }
    fn example() -> &'static str {
        r#"{"verdict":"partial","reason":"The handler exists but the route is not registered."}"#
    }
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
}

fn unique_ids<'a>(ids: impl Iterator<Item = &'a str>, what: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        if id.trim().is_empty() {
            return Err(format!("a {what} has an empty id"));
        }
        if !seen.insert(id) {
            return Err(format!("duplicate {what} id {id:?}"));
        }
    }
    Ok(())
}

/// The step's answer from a finished run: the provider's validated structured output if it gave
/// one, otherwise JSON extracted from the final text. Validated either way.
pub fn read_output<T: AgentOutput>(outcome: &Outcome) -> Result<T, String> {
    let value = match &outcome.structured {
        Some(v) => v.clone(),
        None => super::extract::find_object(&outcome.final_text, T::KEY).ok_or_else(|| {
            format!(
                "no JSON object with a \"{}\" field was found in the answer",
                T::KEY
            )
        })?,
    };
    let parsed: T =
        serde_json::from_value(value).map_err(|e| format!("the JSON does not match: {e}"))?;
    parsed.validate()?;
    Ok(parsed)
}
