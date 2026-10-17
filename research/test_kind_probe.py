from kind_probe import Entity, control_labels, kind_at_depth, labelled_at_depth


def test_kind_at_depth_cuts_the_path() -> None:
    assert kind_at_depth("entity.agent.org.company", 1) == "entity.agent"
    assert kind_at_depth("entity.agent.org.company", 3) == "entity.agent.org.company"
    assert kind_at_depth("entity.place", 2) is None


def test_labelled_at_depth_drops_shallow_paths_and_rare_kinds() -> None:
    entities = [
        Entity("Apple", "entity.agent.org.company"),
        Entity("Uber", "entity.agent.org.company"),
        Entity("Oxfam", "entity.agent.org.nonprofit"),
        Entity("Paris", "entity.place"),
    ]
    names, labels = labelled_at_depth(entities, 3, min_examples=2)
    assert names == ["Apple", "Uber"]
    assert labels == ["entity.agent.org.company"] * 2


def test_control_labels_are_fixed_per_name() -> None:
    names = ["Apple", "Uber", "Apple", "Paris", "Uber", "Apple"]
    labels = ["company", "company", "company", "place", "company", "company"]
    controls = control_labels(names, labels, seed=0)
    by_name: dict[str, set[str]] = {}
    for name, control in zip(names, controls):
        by_name.setdefault(name, set()).add(control)
    assert all(len(kinds) == 1 for kinds in by_name.values())
    assert set(controls) <= set(labels)
    assert controls == control_labels(names, labels, seed=0)
