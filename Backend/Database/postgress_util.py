# This module is used to define utility functions for the PostgresSQL database.
# It includes functions for checking the connection to the database, sorting
# entries, and other common operations.
from postgress_setup import open_session
from sqlalchemy import text


def ping_session():
    try:
        with open_session() as session:
            session.execute(text("SELECT 1"))
            print("Session ping sucesss")
            return True
    except Exception as e:
        print(f"An error occurred while pinging the database in session: \n{e}")
        return False


def list_results(results):
    if isinstance(results, list):
        for result in results:
            print(repr(result))
    else:
        print(repr(results))
