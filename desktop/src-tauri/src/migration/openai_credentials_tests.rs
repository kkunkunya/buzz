use super::*;

fn record(pubkey: &str, name: &str) -> ManagedAgentRecord {
    serde_json::from_value(serde_json::json!({
        "pubkey": pubkey,
        "name": name,
        "relay_url": "wss://relay.example",
        "acp_command": "buzz-acp",
        "agent_command": "buzz-agent",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"
    }))
    .unwrap()
}

fn definition(id: &str) -> ManagedAgentRecord {
    let mut value = record("", id);
    value.slug = Some(id.to_string());
    value.display_name = Some(id.to_string());
    value.system_prompt = Some(String::new());
    value
}

fn planned(global: GlobalAgentConfig, records: Vec<ManagedAgentRecord>) -> Result<Store, String> {
    plan_store(Store { global, records }).map(|(store, _)| store)
}

#[test]
fn whole_store_matrix_classifies_origins_and_moves_only_official_credentials() {
    for (origin, expected_provider, expected_key) in [
        (None, "openai", OPENAI_API_KEY),
        (Some("https://api.openai.com/v1"), "openai", OPENAI_API_KEY),
        (Some("https://api.openai.com"), "openai", OPENAI_API_KEY),
        (
            Some("http://localhost:11434/v1"),
            "openai-compat",
            OPENAI_COMPAT_API_KEY,
        ),
    ] {
        let mut agent = record("agent", "agent");
        agent.provider = Some("openai".into());
        agent
            .env_vars
            .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
        if let Some(origin) = origin {
            agent
                .env_vars
                .insert(OPENAI_COMPAT_BASE_URL.into(), origin.into());
        }

        let store = planned(GlobalAgentConfig::default(), vec![agent]).unwrap();
        assert_eq!(
            store.records[0].provider.as_deref(),
            Some(expected_provider)
        );
        assert_eq!(
            store.records[0]
                .env_vars
                .get(expected_key)
                .map(String::as_str),
            Some("secret")
        );
        if expected_provider == "openai" && origin.is_some() {
            assert_eq!(
                store.records[0]
                    .env_vars
                    .get(OPENAI_COMPAT_BASE_URL)
                    .map(String::as_str),
                Some(CANONICAL_OPENAI_ORIGIN)
            );
        }
    }
}

#[test]
fn malformed_origin_fails_before_mutation() {
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_BASE_URL.into(), "not a url".into());
    assert!(planned(GlobalAgentConfig::default(), vec![agent])
        .unwrap_err()
        .contains("invalid OpenAI endpoint"));
}

#[test]
fn existing_official_key_wins_without_copying_legacy_secret() {
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_API_KEY.into(), "official".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "compat".into());
    let store = planned(GlobalAgentConfig::default(), vec![agent]).unwrap();
    assert_eq!(
        store.records[0].env_vars.get(OPENAI_API_KEY).unwrap(),
        "official"
    );
    assert_eq!(
        store.records[0]
            .env_vars
            .get(OPENAI_COMPAT_API_KEY)
            .unwrap(),
        "compat"
    );
}

#[test]
fn mixed_global_provider_owner_is_rejected() {
    let global = GlobalAgentConfig {
        provider: Some("openai".into()),
        ..Default::default()
    };
    let mut official = record("official", "official");
    official
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "a".into());
    let mut custom = record("custom", "custom");
    custom
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "b".into());
    custom.env_vars.insert(
        OPENAI_COMPAT_BASE_URL.into(),
        "https://gateway.example/v1".into(),
    );
    assert!(planned(global, vec![official, custom])
        .unwrap_err()
        .contains("mixed official/custom"));
}

#[test]
fn mixed_global_credential_owner_is_rejected_even_for_unrelated_consumer() {
    let global = GlobalAgentConfig {
        provider: Some("openai".into()),
        env_vars: BTreeMap::from([(OPENAI_COMPAT_API_KEY.into(), "shared".into())]),
        ..Default::default()
    };
    let official = record("official", "official");
    let mut unrelated = record("unrelated", "unrelated");
    unrelated.provider = Some("anthropic".into());
    assert!(planned(global, vec![official, unrelated])
        .unwrap_err()
        .contains("shared with a non-official consumer"));
}

#[test]
fn linked_provider_snapshot_is_ignored_and_definition_is_mutated() {
    let mut def = definition("shared");
    def.provider = Some("openai".into());
    def.env_vars.insert(
        OPENAI_COMPAT_BASE_URL.into(),
        "https://gateway.example/v1".into(),
    );
    let mut instance = record("instance", "instance");
    instance.persona_id = Some("shared".into());
    instance.provider = Some("anthropic".into());
    instance
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "compat".into());
    let store = planned(GlobalAgentConfig::default(), vec![def, instance]).unwrap();
    assert_eq!(store.records[0].provider.as_deref(), Some("openai-compat"));
    assert_eq!(store.records[1].provider.as_deref(), Some("anthropic"));
}

#[test]
fn linked_local_identity_that_definition_cannot_represent_is_rejected() {
    let mut def = definition("shared");
    def.provider = Some("openai".into());
    let mut official = record("official", "official");
    official.persona_id = Some("shared".into());
    official
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "a".into());
    let mut custom = record("custom", "custom");
    custom.persona_id = Some("shared".into());
    custom
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "b".into());
    custom.env_vars.insert(
        OPENAI_COMPAT_BASE_URL.into(),
        "https://gateway.example/v1".into(),
    );
    assert!(
        planned(GlobalAgentConfig::default(), vec![def, official, custom])
            .unwrap_err()
            .contains("mixed official/custom")
    );
}

#[test]
fn first_fold_builtin_link_does_not_block_unrelated_official_consumer() {
    let mut builtin = record("builtin", "builtin");
    builtin.persona_id = Some("builtin:fizz".into());
    let mut official = record("official", "official");
    official.provider = Some("openai".into());
    official
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    let store = planned(GlobalAgentConfig::default(), vec![builtin, official]).unwrap();
    assert_eq!(
        store.records[1]
            .env_vars
            .get(OPENAI_API_KEY)
            .map(String::as_str),
        Some("secret")
    );
}

#[test]
fn shared_global_official_alias_with_non_openai_consumer_is_rejected() {
    let global = GlobalAgentConfig {
        provider: Some("openai".into()),
        env_vars: BTreeMap::from([(
            OPENAI_COMPAT_BASE_URL.into(),
            "https://api.openai.com".into(),
        )]),
        ..Default::default()
    };
    let official = record("official", "official");
    let mut unrelated = record("unrelated", "unrelated");
    unrelated.provider = Some("anthropic".into());
    assert!(planned(global, vec![official, unrelated])
        .unwrap_err()
        .contains("endpoint owner"));
}

#[test]
fn builtin_read_only_provider_is_accepted_when_identity_already_matches() {
    let mut builtin = record("builtin", "builtin");
    builtin.persona_id = Some("builtin:fizz".into());
    assert!(planned(GlobalAgentConfig::default(), vec![builtin]).is_ok());
}

#[test]
fn canonical_local_shadow_is_preserved_over_inherited_custom_origin() {
    let global = GlobalAgentConfig {
        env_vars: BTreeMap::from([(
            OPENAI_COMPAT_BASE_URL.into(),
            "https://gateway.example/v1".into(),
        )]),
        ..Default::default()
    };
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent.env_vars.insert(
        OPENAI_COMPAT_BASE_URL.into(),
        CANONICAL_OPENAI_ORIGIN.into(),
    );
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    let store = planned(global, vec![agent]).unwrap();
    assert_eq!(
        store.records[0]
            .env_vars
            .get(OPENAI_COMPAT_BASE_URL)
            .map(String::as_str),
        Some(CANONICAL_OPENAI_ORIGIN)
    );
}

#[test]
fn dangling_runtime_requires_command_override() {
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent.runtime = Some("missing-custom-runtime".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    assert!(planned(GlobalAgentConfig::default(), vec![agent.clone()])
        .unwrap_err()
        .contains("unresolved custom harness"));
    agent.agent_command_override = Some("buzz-agent".into());
    assert!(planned(GlobalAgentConfig::default(), vec![agent]).is_ok());
}

#[test]
fn semantic_failure_creates_no_transaction_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_BASE_URL.into(), "broken".into());
    std::fs::write(
        agents.join("managed-agents.json"),
        serde_json::to_vec(&vec![agent]).unwrap(),
    )
    .unwrap();
    assert!(migrate_pair(agents).is_err());
    assert!(!agents.join(MANIFEST_FILE).exists());
    assert!(!agents.join(MARKER_FILE).exists());
    assert!(!sibling_path(&agents.join("managed-agents.json"), BACKUP_SUFFIX).exists());
}

#[test]
fn stale_backup_is_refused_before_manifest_or_config_write() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    let source = serde_json::to_vec(&vec![agent]).unwrap();
    let path = agents.join("managed-agents.json");
    std::fs::write(&path, &source).unwrap();
    std::fs::write(sibling_path(&path, BACKUP_SUFFIX), b"stale").unwrap();
    assert!(migrate_pair(agents)
        .unwrap_err()
        .contains("backup does not match pristine source"));
    assert_eq!(std::fs::read(path).unwrap(), source);
    assert!(!agents.join(MANIFEST_FILE).exists());
    assert!(!agents.join(MARKER_FILE).exists());
}

#[test]
fn transaction_writes_backups_manifest_targets_then_marker() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let global = GlobalAgentConfig {
        provider: Some("openai".into()),
        ..Default::default()
    };
    let mut agent = record("agent", "agent");
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    std::fs::write(
        agents.join("global-agent-config.json"),
        serde_json::to_vec(&global).unwrap(),
    )
    .unwrap();
    std::fs::write(
        agents.join("managed-agents.json"),
        serde_json::to_vec(&vec![agent]).unwrap(),
    )
    .unwrap();
    migrate_pair(agents).unwrap();
    assert!(agents.join(MANIFEST_FILE).exists());
    assert!(agents.join(MARKER_FILE).exists());
    assert!(sibling_path(&agents.join("global-agent-config.json"), BACKUP_SUFFIX).exists());
    assert!(sibling_path(&agents.join("managed-agents.json"), BACKUP_SUFFIX).exists());
    let reread: Vec<ManagedAgentRecord> =
        serde_json::from_slice(&std::fs::read(agents.join("managed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(
        reread[0].env_vars.get(OPENAI_API_KEY).map(String::as_str),
        Some("secret")
    );
}

#[test]
fn marker_write_failure_leaves_verified_targets_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    std::fs::write(
        agents.join("managed-agents.json"),
        serde_json::to_vec(&vec![agent]).unwrap(),
    )
    .unwrap();
    std::fs::create_dir(agents.join(MARKER_FILE)).unwrap();

    assert!(migrate_pair(agents).is_err());
    assert!(agents.join(MANIFEST_FILE).exists());
    let target: Vec<ManagedAgentRecord> =
        serde_json::from_slice(&std::fs::read(agents.join("managed-agents.json")).unwrap())
            .unwrap();
    assert_eq!(
        target[0].env_vars.get(OPENAI_API_KEY).map(String::as_str),
        Some("secret")
    );

    std::fs::remove_dir(agents.join(MARKER_FILE)).unwrap();
    migrate_pair(agents).unwrap();
    assert_eq!(std::fs::read(agents.join(MARKER_FILE)).unwrap(), b"1\n");
}

#[test]
fn malformed_marker_does_not_suppress_retry() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    std::fs::write(
        agents.join("managed-agents.json"),
        serde_json::to_vec(&vec![agent]).unwrap(),
    )
    .unwrap();
    std::fs::write(agents.join(MARKER_FILE), b"").unwrap();
    migrate_pair(agents).unwrap();
    assert_eq!(std::fs::read(agents.join(MARKER_FILE)).unwrap(), b"1\n");
}

#[test]
fn post_write_verification_rejects_hash_mismatch() {
    let mut agent = record("agent", "agent");
    agent.provider = Some("openai".into());
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    let source = serde_json::to_vec(&vec![agent]).unwrap();
    let plan = make_plan(None, Some(&source)).unwrap();
    let expected = TransactionManifest {
        global: FileHashes {
            source: None,
            target: hash(plan.global.as_deref()),
        },
        managed: FileHashes {
            source: hash(Some(&source)),
            target: hash(plan.managed.as_deref()),
        },
    };

    let err = verify_written_targets(&expected, &plan.consumers, None, Some(b"[]")).unwrap_err();
    assert!(err.contains("target hash mismatch"));
}

#[test]
fn partial_retry_finishes_expected_target_but_refuses_external_edit() {
    let dir = tempfile::tempdir().unwrap();
    let agents = dir.path();
    let global_bytes = serde_json::to_vec(&GlobalAgentConfig {
        provider: Some("openai".into()),
        ..Default::default()
    })
    .unwrap();
    let mut agent = record("agent", "agent");
    agent
        .env_vars
        .insert(OPENAI_COMPAT_API_KEY.into(), "secret".into());
    let managed_bytes = serde_json::to_vec(&vec![agent]).unwrap();
    let plan = make_plan(Some(&global_bytes), Some(&managed_bytes)).unwrap();
    std::fs::write(
        agents.join("global-agent-config.json"),
        plan.global.as_ref().unwrap(),
    )
    .unwrap();
    std::fs::write(agents.join("managed-agents.json"), &managed_bytes).unwrap();
    std::fs::write(
        sibling_path(&agents.join("global-agent-config.json"), BACKUP_SUFFIX),
        &global_bytes,
    )
    .unwrap();
    std::fs::write(
        sibling_path(&agents.join("managed-agents.json"), BACKUP_SUFFIX),
        &managed_bytes,
    )
    .unwrap();
    let manifest = TransactionManifest {
        global: FileHashes {
            source: hash(Some(&global_bytes)),
            target: hash(plan.global.as_deref()),
        },
        managed: FileHashes {
            source: hash(Some(&managed_bytes)),
            target: hash(plan.managed.as_deref()),
        },
    };
    std::fs::write(
        agents.join(MANIFEST_FILE),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    migrate_pair(agents).unwrap();
    assert!(agents.join(MARKER_FILE).exists());

    std::fs::remove_file(agents.join(MARKER_FILE)).unwrap();
    std::fs::write(agents.join("managed-agents.json"), b"[]").unwrap();
    assert!(migrate_pair(agents).unwrap_err().contains("external edit"));
}
