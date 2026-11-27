use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use ca_core::engine::Engine;
use ca_core::engine::pr::{PrReport, PrResult};
use ca_core::engine::runlog::{RunLogInfo, RunLogLine};
use ca_core::task::PullRequest;
use ca_core::util::ROOT_REPO;
use ca_core::{CoreError, PrHost, Provider, Task, TaskList};
use serde_json::{Map, Value};

use super::types::{
    AnswersRequest, CreateTaskRequest, FeedbackRequest, MoveRequest, PlanRequest,
    PullRequestResponse,
};
use super::{Body, check_provider};
use crate::error::ApiError;
use crate::state::{AppState, Project};

type ApiResult<T> = Result<Json<T>, ApiError>;

/// The task as it is now, for commands whose engine call returns nothing.
async fn current(engine: &Engine, id: &str) -> ApiResult<Task> {
    engine
        .get_task(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("task {id} not found")))
}

pub async fn list(Project(engine): Project) -> ApiResult<TaskList> {
    Ok(Json(engine.list_tasks().await?))
}

pub async fn get(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    current(&engine, &id).await
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Project(engine): Project,
    Body(req): Body<CreateTaskRequest>,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    check_provider(&state, req.agent.provider)?;
    let mut agent = req.agent;
    default_mock_scenario(&state, agent.provider, &mut agent.options);
    let (title, description, approval) = (&req.title, &req.description, req.require_plan_approval);
    let task = if req.start {
        engine
            .create_and_start(title, description, agent, approval)
            .await?
    } else {
        engine
            .create_task(title, description, agent, approval)
            .await?
    };
    Ok((StatusCode::CREATED, Json(task)))
}

/// A mock agent with no scenario plays the server's `--mock-scenario`, if it has one (the UI has
/// no field for a scenario). Used on create and on edit.
fn default_mock_scenario(state: &AppState, provider: Provider, options: &mut Map<String, Value>) {
    if provider == Provider::Mock
        && !options.contains_key("scenario")
        && let Some(scenario) = &state.config.mock_scenario
    {
        options.insert(
            "scenario".into(),
            Value::String(scenario.display().to_string()),
        );
    }
}

/// Edit title, description, agent or plan approval; any other key is refused.
pub async fn patch(
    State(state): State<Arc<AppState>>,
    Project(engine): Project,
    Path(id): Path<String>,
    Body(patch): Body<Map<String, Value>>,
) -> ApiResult<Task> {
    let mut patch = patch;
    if let Some(agent) = patch.get_mut("agent").and_then(Value::as_object_mut)
        && let Some(provider) = agent
            .get("provider")
            .and_then(|p| serde_json::from_value::<Provider>(p.clone()).ok())
    {
        check_provider(&state, provider)?;
        if provider == Provider::Mock {
            let options = agent
                .entry("options")
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(options) = options.as_object_mut() {
                default_mock_scenario(&state, provider, options);
            }
        }
    }
    Ok(Json(engine.patch_task(&id, &patch).await?))
}

pub async fn delete(
    Project(engine): Project,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    // A task file that cannot be read can still be deleted; only a missing one is a 404.
    match engine.get_task(&id).await {
        Ok(None) => return Err(ApiError::not_found(format!("task {id} not found"))),
        Err(e @ ca_core::CoreError::InvalidTaskId(_)) => return Err(e.into()),
        Ok(Some(_)) | Err(_) => {}
    }
    engine.delete_task(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A user drag: the phase table decides, and agents never start from a move.
pub async fn move_to(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<MoveRequest>,
) -> ApiResult<Task> {
    Ok(Json(engine.move_task(&id, req.to).await?))
}

pub async fn start(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.start(&id).await?;
    current(&engine, &id).await
}

/// Returns once the agent has stopped and the run is recorded as paused.
pub async fn pause(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.pause(&id).await?;
    current(&engine, &id).await
}

pub async fn resume(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.resume(&id).await?;
    current(&engine, &id).await
}

pub async fn answers(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<AnswersRequest>,
) -> ApiResult<Task> {
    engine
        .answer_questions(&id, req.answers.into_iter().collect())
        .await?;
    current(&engine, &id).await
}

pub async fn revise_plan(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<FeedbackRequest>,
) -> ApiResult<Task> {
    engine.revise_plan(&id, &req.feedback).await?;
    current(&engine, &id).await
}

pub async fn edit_plan(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<PlanRequest>,
) -> ApiResult<Task> {
    Ok(Json(engine.edit_plan(&id, &req.plan).await?))
}

pub async fn approve_plan(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.approve_plan(&id).await?;
    current(&engine, &id).await
}

pub async fn rework(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<FeedbackRequest>,
) -> ApiResult<Task> {
    engine.request_rework(&id, &req.feedback).await?;
    current(&engine, &id).await
}

pub async fn skip_subtask(
    Project(engine): Project,
    Path((id, subtask)): Path<(String, String)>,
) -> ApiResult<Task> {
    Ok(Json(engine.skip_subtask(&id, &subtask).await?))
}

pub async fn pull_request(
    Project(engine): Project,
    Path(id): Path<String>,
) -> ApiResult<PullRequestResponse> {
    let report = engine.create_pull_request(&id).await?;
    Ok(Json(single_response(report)?))
}

/// The one-result answer the pre-3.1 UI understands. Anything it cannot show truthfully is an
/// error: a repository whose push failed (even if others worked), and a repository with no
/// remote (it would read as "pushed"). With several repositories pushed, the note names the rest.
fn single_response(report: PrReport) -> Result<PullRequestResponse, ApiError> {
    let failed: Vec<String> = report
        .rows
        .iter()
        .filter_map(|r| match &r.result {
            PrResult::Failed { error } => Some(format!("{}: {error}", r.repo)),
            PrResult::NoRemote { branch } => Some(format!(
                "{}: the repository has no `origin` remote to push {branch} to",
                r.repo
            )),
            _ => None,
        })
        .collect();
    let pushed: Vec<(String, PullRequest, Option<String>)> = report
        .rows
        .into_iter()
        .filter_map(|r| match r.result {
            PrResult::Pushed { pull_request, note } => Some((r.repo, pull_request, note)),
            _ => None,
        })
        .collect();
    let one_repo = |s: &str| s.strip_prefix(&format!("{ROOT_REPO}: ")).map(String::from);
    if !failed.is_empty() {
        let mut msg = match failed.as_slice() {
            [only] => one_repo(only).unwrap_or_else(|| only.clone()),
            all => all.join("; "),
        };
        if !pushed.is_empty() {
            let done: Vec<&str> = pushed.iter().map(|(r, _, _)| r.as_str()).collect();
            msg.push_str(&format!(" (pushed: {})", done.join(", ")));
        }
        return Err(CoreError::Invalid(msg).into());
    }
    let mut rest = pushed.into_iter();
    let Some((_, pr, note)) = rest.next() else {
        return Err(CoreError::Invalid(
            "nothing to open a pull request for: the task changed no repository".into(),
        )
        .into());
    };
    let others: Vec<String> = rest
        .map(|(repo, p, _)| match p.url {
            Some(url) => format!("{repo}: {url}"),
            None => format!("{repo}: branch pushed"),
        })
        .collect();
    let note = match (note, others.is_empty()) {
        (note, true) => note,
        (note, false) => Some(
            note.into_iter()
                .chain([format!("Also pushed: {}", others.join("; "))])
                .collect::<Vec<_>>()
                .join(" "),
        ),
    };
    Ok(PullRequestResponse {
        url: pr.url,
        host: pr.host.unwrap_or(PrHost::Github),
        note,
    })
}

/// The files the task changed, per repository.
pub async fn changes(
    Project(engine): Project,
    Path(id): Path<String>,
) -> ApiResult<Vec<ca_core::engine::RepoChanges>> {
    Ok(Json(engine.changes(&id).await?))
}

/// Open or update the pull request of every repository the task changed.
pub async fn pull_requests(
    Project(engine): Project,
    Path(id): Path<String>,
) -> ApiResult<PrReport> {
    Ok(Json(engine.create_pull_request(&id).await?))
}

pub async fn runs(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Vec<RunLogInfo>> {
    Ok(Json(engine.run_logs(&id).await?))
}

pub async fn run_events(
    Project(engine): Project,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult<Vec<RunLogLine>> {
    Ok(Json(engine.run_log(&id, &name).await?))
}
