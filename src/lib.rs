use std::fs;
use std::path::{Path, PathBuf};

use zed_extension_api as zed;

const SERVER_ID: &str = "monkeyc-fmt";
const FORMATTER_REVISION: &str = "c69c2a5d348d447192d29935049309fe2276f59e";
const FORMATTER_REPOSITORY: &str = "https://github.com/DuckSoft/monkeyc-fmt";
const SERVER_SCRIPT: &str = include_str!("server.mjs");

struct MonkeyCExtension;

impl MonkeyCExtension {
    fn absolute_cache_root() -> Result<PathBuf, String> {
        Ok(std::env::current_dir()
            .map_err(|error| format!("failed to locate the extension work directory: {error}"))?
            .join("monkeyc-fmt")
            .join(FORMATTER_REVISION))
    }

    fn path_string(path: &Path, description: &str) -> Result<String, String> {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("{description} is not valid UTF-8: {}", path.display()))
    }

    fn formatter_name() -> &'static str {
        match zed::current_platform().0 {
            zed::Os::Windows => "monkeyc-fmt.exe",
            zed::Os::Mac | zed::Os::Linux => "monkeyc-fmt",
        }
    }

    fn installation_failed(language_server_id: &zed::LanguageServerId, message: String) -> String {
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Failed(message.clone()),
        );
        message
    }

    fn formatter_path(
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
        cache_root: &Path,
    ) -> Result<String, String> {
        let formatter_name = Self::formatter_name();
        if let Some(path) = worktree.which(formatter_name) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::None,
            );
            return Ok(path);
        }

        let cached_binary = cache_root.join("bin").join(formatter_name);
        if cached_binary.is_file() {
            let path = Self::path_string(&cached_binary, "cached formatter path")?;
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::None,
            );
            return Ok(path);
        }

        let cargo = worktree.which("cargo").ok_or_else(|| {
            Self::installation_failed(
                language_server_id,
                "monkeyc-fmt was not found on PATH or in Zed's extension cache, and cargo is not available to install it. Install Rust stable and a native C compiler, or put monkeyc-fmt on PATH."
                    .to_string(),
            )
        })?;

        fs::create_dir_all(cache_root).map_err(|error| {
            Self::installation_failed(
                language_server_id,
                format!(
                    "failed to create formatter cache directory {}: {error}",
                    cache_root.display()
                ),
            )
        })?;
        let install_root = Self::path_string(cache_root, "formatter cache directory")
            .map_err(|message| Self::installation_failed(language_server_id, message))?;

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );

        let output = zed::process::Command::new(cargo)
            .args([
                "+stable",
                "install",
                "--git",
                FORMATTER_REPOSITORY,
                "--rev",
                FORMATTER_REVISION,
                "--locked",
                "--root",
                install_root.as_str(),
                "monkeyc-fmt",
            ])
            .envs(worktree.shell_env())
            .output();

        let output = match output {
            Ok(output) => output,
            Err(error) => {
                let message = format!("failed to run cargo to install monkeyc-fmt: {error}");
                return Err(Self::installation_failed(language_server_id, message));
            }
        };

        if output.status != Some(0) || !cached_binary.is_file() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = format!(
                "cargo could not install monkeyc-fmt from revision {FORMATTER_REVISION} (status {:?}).\nstdout:\n{stdout}\nstderr:\n{stderr}",
                output.status
            );
            return Err(Self::installation_failed(language_server_id, message));
        }

        let path = Self::path_string(&cached_binary, "installed formatter path")
            .map_err(|message| Self::installation_failed(language_server_id, message))?;
        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::None,
        );
        Ok(path)
    }
}

impl zed::Extension for MonkeyCExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!(
                "unsupported language server `{}`; expected `{SERVER_ID}`",
                language_server_id.as_ref()
            ));
        }

        // Resolve Node before attempting a potentially expensive native Cargo build.
        let node = zed::node_binary_path()
            .map_err(|error| format!("failed to resolve Zed's managed Node.js runtime: {error}"))?;
        let cache_root = Self::absolute_cache_root()?;
        let formatter = Self::formatter_path(language_server_id, worktree, &cache_root)?;

        fs::create_dir_all(&cache_root).map_err(|error| {
            format!(
                "failed to create language server cache directory {}: {error}",
                cache_root.display()
            )
        })?;
        let script = cache_root.join(concat!("server-", env!("CARGO_PKG_VERSION"), ".mjs"));
        fs::write(&script, SERVER_SCRIPT).map_err(|error| {
            format!(
                "failed to write the formatting language server to {}: {error}",
                script.display()
            )
        })?;
        let script = Self::path_string(&script, "language server script path")?;

        Ok(zed::Command {
            command: node,
            args: vec![script, formatter],
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<Option<zed::serde_json::Value>> {
        Ok(zed::settings::LspSettings::for_worktree(SERVER_ID, worktree)?.initialization_options)
    }
}

zed::register_extension!(MonkeyCExtension);
