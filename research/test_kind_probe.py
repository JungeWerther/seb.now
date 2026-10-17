from kind_probe import Entity, kind_at_depth, labelled_at_depth


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
