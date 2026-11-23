from hannah_robot_os.network.bridge import OfflineQueue, make_heartbeat


def test_offline_queue_push_drain():
    q = OfflineQueue(max_items=2)
    q.push(make_heartbeat("r1", "e1"))
    q.push(make_heartbeat("r1", "e2"))
    q.push(make_heartbeat("r1", "e3"))
    assert q.size() == 2
    drained = q.drain(10)
    assert [e.envelope_id for e in drained] == ["e2", "e3"]
    assert q.size() == 0
