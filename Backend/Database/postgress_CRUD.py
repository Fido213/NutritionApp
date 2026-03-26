# This module is used to perform CRUD operations on the PostgresSQL database.
from postgress_setup import open_session, Log
import datetime
from postgress_util import list_results


def create(table, id, user, Food):
    try:
        with open_session() as session:
            current_time = datetime.datetime.now(datetime.timezone.utc)
            new_entry = table(ID=id, created_at=current_time, user_id=user, food=Food)
            session.add(new_entry)
            session.commit()
            print("success")
    except Exception as e:
        print(f"error: \n{e}")


def read(Table, showresults: bool, attribute: str, id=None):
    try:
        with open_session() as session:
            if not id:
                if hasattr(Table, attribute):
                    order = getattr(Table, attribute)
                else:
                    order = getattr(Table, "ID")
                rows = session.query(Table).order_by(order).all()
                if showresults:
                    list_results(rows)
                return rows
            else:
                row = session.query(Table).filter_by(ID=id).all()
                if showresults:
                    list_results(row)
                return row
    except Exception as e:
        print(f"Error, returned an empty list \n cause:{e}")
        return [] if id is None else None


def update():
    pass


def delete():
    pass


read(Log, True, "user_id", 2)
