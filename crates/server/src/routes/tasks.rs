use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use ca_core::engine::Engine;
use ca_core::engine::runlog::{RunLogInfo, RunLogLine};
use ca_core::{PrHost, Provider, Task, TaskList};
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
    let outcome = engine.create_pull_request(&id).await?;
    let pr = outcome.pull_request;
    Ok(Json(PullRequestResponse {
        url: pr.url,
        host: pr.host.unwrap_or(PrHost::Github),
        note: outcome.note,
    }))
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
