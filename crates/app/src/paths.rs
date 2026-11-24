//! Which paths the page may ask the app to open: only folders inside a project the server has
//! open. The page is ours, but a path is still checked here, so nothing the page is tricked into
//! sending (a crafted task title in a link, say) can open an arbitrary folder or program.

use std::path::{Path, PathBuf};

/// `path`, resolved (symlinks and `..` followed), if it is an existing folder inside one of
/// `roots`. The error is written for the user.
pub fn inside_open_project(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err("the path must be absolute".into());
    }
    let resolved = canonical(given).map_err(|_| format!("{path} does not exist"))?;
    if !resolved.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let inside = roots
        .iter()
        .filter_map(|root| canonical(root).ok())
        .any(|root| resolved.starts_with(&root));
    if inside {
        Ok(resolved)
    } else {
        Err(format!(
            "{path} is not inside a project open in Code-Automata"
        ))
    }
}

fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).map(ca_core::util::plain_path)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        project: PathBuf,
        outside: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path()).unwrap();
        let project = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(project.join(".code-automata/worktrees/t1")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(project.join("file.txt"), "x").unwrap();
        Fixture {
            _dir: dir,
            project,
            outside,
        }
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    #[test]
    fn a_folder_inside_an_open_project_is_allowed() {
        let f = fixture();
        let roots = vec![f.project.clone()];
        let wt = f.project.join(".code-automata/worktrees/t1");
        assert_eq!(inside_open_project(s(&wt), &roots).unwrap(), wt);
        assert_eq!(
            inside_open_project(s(&f.project), &roots).unwrap(),
            f.project
        );
    }

    #[test]
    fn outside_every_project_missing_relative_or_a_file_is_refused() {
        let f = fixture();
        let roots = vec![f.project.clone()];
        let err = inside_open_project(s(&f.outside), &roots).unwrap_err();
        assert!(err.contains("not inside a project"), "{err}");
        assert!(inside_open_project(s(&f.outside), &[]).is_err());
        assert!(
            inside_open_project(s(&f.project.join("gone")), &roots)
                .unwrap_err()
                .contains("does not exist")
        );
        assert!(
            inside_open_project("relative/path", &roots)
                .unwrap_err()
                .contains("absolute")
        );
        assert!(
            inside_open_project(s(&f.project.join("file.txt")), &roots)
                .unwrap_err()
                .contains("not a folder")
        );
    }

    #[test]
    fn dot_dot_cannot_climb_out_of_a_project() {
        let f = fixture();
        let roots = vec![f.project.clone()];
        let sneaky = f.project.join(".code-automata/../../outside");
        assert!(inside_open_project(s(&sneaky), &roots).is_err());
    }

    #[test]
    fn a_name_sharing_the_root_prefix_is_not_inside_it() {
        let f = fixture();
        let sibling = f.project.with_file_name("project-other");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(inside_open_project(s(&sibling), std::slice::from_ref(&f.project)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_project_is_refused() {
        let f = fixture();
        let link = f.project.join("escape");
        std::os::unix::fs::symlink(&f.outside, &link).unwrap();
        assert!(inside_open_project(s(&link), std::slice::from_ref(&f.project)).is_err());
    }
}
